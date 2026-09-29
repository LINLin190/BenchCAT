from __future__ import annotations

import ctypes.util
import logging
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from ..al_status import al_status_info
from ..models import (
    AdapterInfo,
    EtherCatState,
    ObjectDictionaryEntry,
    PdoDirection,
    PdoEntry,
    ProcessDataSnapshot,
    SlaveIdentity,
    SlaveInfo,
)
from ..sii.parser import SiiParser, validate_eeprom_range
from .base import DEFAULT_STATE_TRANSITION_TIMEOUT_US, CommunicationError, EepromReadback, EnvironmentError
from .passive_discovery import (
    NpcapEthercatTransport,
    PassiveDiscoveryError,
    PassiveMediaDisconnected,
    PassiveSlave,
    _sm_sizes,
    decode_native_text,
)
from .passive_discovery import discover as passive_discover

# Discovery must remain bounded when a slave does not implement an optional
# ESC register.  EtherCAT round trips are normally below 1 ms; 2 ms leaves
# room for a loaded Windows host without allowing one probe to consume the
# whole scan deadline.
DISCOVERY_FPRD_TIMEOUT_US = 2_000
logger = logging.getLogger(__name__)


def _decode_adapter_description(value: object) -> str:
    if isinstance(value, bytes):
        return decode_native_text(value)
    return str(value)


def _chip_from_register(
    raw: bytes,
    *,
    fmmu_count: int | None = None,
    sm_count: int | None = None,
    ram_kib: int | None = None,
) -> tuple[str, str]:
    text = raw.rstrip(b"\x00").decode("ascii", errors="ignore").upper()
    candidates = {"E101": "ET1100_COMPATIBLE", "E252": "LAN9252_COMPATIBLE", "E253": "LAN9253_COMPATIBLE"}
    for model, family in candidates.items():
        chip_id = int(model, 16)
        # Vendor ESC identification registers are seen as either a 16-bit
        # value or a 32-bit value depending on the PDI bridge byte order.
        register_values = {
            int.from_bytes(raw, "little"),
            int.from_bytes(raw, "big"),
            int.from_bytes(raw[:2], "little") if len(raw) >= 2 else -1,
            int.from_bytes(raw[:2], "big") if len(raw) >= 2 else -1,
        }
        if model in text or chip_id in register_values:
            return model, family
    # LAN9252 exposes 3 FMMUs, 4 SyncManagers and 4 KiB DPRAM. This
    # capability signature is used only for the original Microchip part;
    # domestic compatible models remain identifiable solely by model text
    # or their explicit chip register value above.
    if (fmmu_count, sm_count, ram_kib) == (3, 4, 4):
        return "LAN9252", "LAN9252_COMPATIBLE"
    return "Generic ESC", "GENERIC"


# E252 reports ESC Type 0xAE. Its 0x0E00 Chip ID field may contain the
# original LAN9252/LAN9253 number or its own E252 id; the displayed model
# is still E252. Type 0xC0 remains the original Microchip parts.
_E252_ESC_TYPE = 0xAE
_E252_CHIP_IDS = {0x9252, 0x9253, 0xE252}


def _chip_from_identification_registers(
    esc_type: bytes,
    chip_id: bytes,
) -> tuple[str, str]:
    """Resolve the ESC using its authoritative identification registers."""
    if esc_type and esc_type[0] == 0x11:
        return "ET1100", "ET1100_COMPATIBLE"
    model = int.from_bytes(chip_id[:2], "little") if len(chip_id) >= 2 else None
    if esc_type and esc_type[0] == _E252_ESC_TYPE and model in _E252_CHIP_IDS:
        return "E252", "LAN9252_COMPATIBLE"
    if model == 0x9252:
        return "LAN9252", "LAN9252_COMPATIBLE"
    if model == 0x9253:
        return "LAN9253", "LAN9253_COMPATIBLE"
    return "Generic ESC", "GENERIC"


class PysoemBackend:
    """Thin pySOEM adapter. Every method must be invoked only by EtherCatWorker."""

    def __init__(self) -> None:
        self._pysoem: Any = None
        self._master: Any = None
        self._passive: NpcapEthercatTransport | None = None
        self._adapter_name: str | None = None
        self._connected = False
        self._mapped = False
        self._mapping_attempted = False
        self._slaves: list[SlaveInfo] = []
        self._cycle_count = 0
        self._wkc_errors = 0
        self._timeouts = 0
        self._consecutive = 0
        self._pdo_size_cache: dict[tuple[int, int, int], tuple[int, int]] = {}

    @property
    def connected(self) -> bool:
        return self._connected

    def _load(self) -> Any:
        if self._pysoem is None:
            try:
                import pysoem
            except (ImportError, OSError) as exc:
                raise EnvironmentError(
                    "无法加载 pySOEM/Npcap。请安装 pysoem==1.1.13 和 Npcap，并启用 WinPcap API-compatible Mode。"
                ) from exc
            if pysoem.__version__ != "1.1.13":
                raise EnvironmentError(f"需要 pysoem 1.1.13，当前为 {pysoem.__version__}")
            self._pysoem = pysoem
        return self._pysoem

    def enumerate_adapters(self) -> list[AdapterInfo]:
        pysoem = self._load()
        try:
            adapters = pysoem.find_adapters()
        except (OSError, RuntimeError) as exc:
            raise EnvironmentError(
                "无法枚举网卡。请确认 Npcap 已安装并启用 WinPcap API-compatible Mode。"
            ) from exc
        return [AdapterInfo(a.name, _decode_adapter_description(a.desc)) for a in adapters]

    def connect(self, adapter_name: str) -> None:
        pysoem = self._load()
        master = pysoem.Master()
        master.always_release_gil = True
        passive = NpcapEthercatTransport(adapter_name)
        try:
            master.open(adapter_name)
            passive.open()
        except (ConnectionError, OSError, PassiveDiscoveryError) as exc:
            try:
                master.close()
            except Exception:
                pass
            passive.close()
            hint = "请检查网卡状态、管理员权限以及 Npcap 的 WinPcap 兼容模式。"
            if ctypes.util.find_library("wpcap") is None:
                hint = "未检测到 Npcap/wpcap，请安装 Npcap 并启用 WinPcap API-compatible Mode。"
            raise EnvironmentError(f"无法打开 EtherCAT 网卡。{hint}") from exc
        self._master = master
        self._passive = passive
        self._adapter_name = adapter_name
        self._connected = True
        self._mapped = False
        self._mapping_attempted = False

    def disconnect(self) -> None:
        try:
            if self._passive is not None:
                self._passive.close()
            if self._master is not None:
                self._master.close()
        finally:
            self._passive = None
            self._adapter_name = None
            self._master = None
            self._connected = False
            self._mapped = False
            self._mapping_attempted = False
            self._slaves = []

    def _require_master(self) -> Any:
        if not self._connected or self._master is None:
            raise CommunicationError("Master is not connected")
        return self._master

    def _slave(self, position: int) -> Any:
        master = self._require_master()
        self._ensure_operational()
        if not 1 <= position <= len(master.slaves):
            raise CommunicationError(f"Slave {position} is not available")
        return master.slaves[position - 1]

    def _config_init(self, *, manual_state_change: bool = False) -> int:
        master = self._require_master()
        if not manual_state_change:
            return int(master.config_init(False, release_gil=True))
        previous = master.manual_state_change
        try:
            master.manual_state_change = True
            return int(master.config_init(False, release_gil=True))
        finally:
            master.manual_state_change = previous

    def _ensure_operational(self, *, manual_state_change: bool = False) -> Any:
        master = self._require_master()
        if master.slaves:
            return master
        try:
            count = self._config_init(manual_state_change=manual_state_change)
        except Exception as exc:
            raise CommunicationError(f"初始化从站运行通道失败：{exc}") from exc
        if count != len(self._slaves) or count <= 0:
            raise CommunicationError("无法执行该操作：从站初始化失败")
        self._mapping_attempted = False
        self._mapped = False
        return master

    def _serial(self, slave: Any) -> int:
        try:
            # Serial is the 32-bit SII identity field beginning at word 0x0E.
            # Do not probe optional CoE 0x1018 during discovery: devices without
            # mailbox support otherwise consume the full SDO timeout per slave.
            return int.from_bytes(slave.eeprom_read(0x0E), "little")
        except Exception:
            return 0

    def _sii_discovery_info(
        self, slave: Any, position: int | None = None
    ) -> tuple[int | None, int | None, str | None, str | None]:
        """Read the bounded SII summary needed during discovery."""
        deadline = time.monotonic() + 0.1
        cached_capacity_words: int | None = None
        cached_categories = b""
        if position is not None:
            try:
                size_data = self.eeprom_read_block(position, 0x3E, 4).data
                cached_capacity_words = (int.from_bytes(size_data[:2], "little") + 1) * 64
                category_words = min(max(cached_capacity_words - 0x40, 0), 256)
                if category_words:
                    cached_categories = self.eeprom_read_block(
                        position, 0x40, category_words * 2
                    ).data
            except Exception:
                return None, None, None, None

        def read(word: int) -> bytes:
            if cached_capacity_words is not None:
                if word == 0x3E:
                    return (cached_capacity_words // 64 - 1).to_bytes(2, "little") + b"\x01\x00"
                offset = (word - 0x40) * 2
                value = cached_categories[offset:offset + 4]
                if len(value) != 4:
                    raise ValueError("SII discovery summary exceeds bounded prefix")
                return value
            if time.monotonic() >= deadline:
                raise TimeoutError("SII discovery deadline exceeded")
            value = slave.eeprom_read(word, timeout=DISCOVERY_FPRD_TIMEOUT_US)
            if len(value) != 4:
                raise ValueError("Truncated SII word read")
            return value

        def payload(start: int, words: int) -> bytes:
            chunks = [read(start + offset) for offset in range(0, words, 2)]
            return b"".join(chunks)[: words * 2]

        strings: tuple[str, ...] = ()
        general = b""
        input_size: int | None = None
        output_size: int | None = None
        try:
            capacity_words = (int.from_bytes(read(0x3E)[:2], "little") + 1) * 64
            word = 0x40
            for _ in range(128):
                if word + 2 > min(capacity_words, 0x10000):
                    break
                header = read(word)
                kind = int.from_bytes(header[:2], "little")
                length = int.from_bytes(header[2:], "little")
                if kind == 0xFFFF or word + 2 + length > min(capacity_words, 0x10000):
                    break
                if kind == 0x000A:
                    strings = SiiParser._parse_strings(payload(word + 2, length))
                elif kind == 0x001E:
                    general = payload(word + 2, length)
                elif kind == 0x0029:
                    if length % 4 or length > 16 * 4:
                        break
                    sizes: dict[int, int | None] = {3: 0, 4: 0}
                    for offset in range(word + 2, word + 2 + length, 4):
                        sm = read(offset) + read(offset + 2)
                        if sm[7] in sizes and sm[6] & 1:
                            size = int.from_bytes(sm[2:4], "little")
                            previous = sizes[sm[7]]
                            # An enabled SM with no default length needs online mapping.
                            sizes[sm[7]] = (
                                previous + size if size and previous is not None else None
                            )
                    input_size, output_size = sizes[4], sizes[3]
                    break
                word += 2 + length

        except Exception:
            pass

        def string(index: int) -> str | None:
            return strings[index - 1] if 0 < index <= len(strings) else None

        product_type = string(general[0]) if len(general) >= 1 else None
        product_model = None
        if len(general) >= 4:
            product_model = string(general[2]) or string(general[3])
        return input_size, output_size, product_type, product_model

    def _sii_pdo_sizes(self, slave: Any) -> tuple[int | None, int | None]:
        input_size, output_size, _, _ = self._sii_discovery_info(slave)
        return input_size, output_size

    def _basic_info(self, position: int, slave: Any) -> SlaveInfo:
        try:
            state = EtherCatState(int(slave.state) & 0x0F)
        except ValueError:
            state = EtherCatState.NONE
        key = (int(slave.man), int(slave.id), int(slave.rev))
        input_size, output_size = self._pdo_size_cache.get(key, (None, None))
        return SlaveInfo(
            position,
            slave.name,
            SlaveIdentity(slave.man, slave.id, slave.rev, 0),
            state,
            int(slave.al_status),
            input_size,
            output_size,
            raw_state=int(slave.state),
            pdo_size_source="cache" if input_size is not None else "unknown",
        )

    def _info(self, position: int, slave: Any) -> SlaveInfo:
        basic = self._basic_info(position, slave)
        configured_address = None
        pdi_type = None
        chip_model, family = "Generic ESC", "GENERIC"
        try:
            configured_address = int.from_bytes(
                slave._fprd(0x0010, 2, DISCOVERY_FPRD_TIMEOUT_US), "little"
            )
        except Exception:
            pass
        try:
            pdi_type = slave._fprd(0x0140, 1, DISCOVERY_FPRD_TIMEOUT_US)[0]
        except Exception:
            pass
        esc_type = b""
        try:
            esc_type = slave._fprd(0x0000, 1, DISCOVERY_FPRD_TIMEOUT_US)
        except Exception:
            pass
        chip_id = b""
        try:
            if not (esc_type and esc_type[0] == 0x11):
                chip_id = slave._fprd(0x0E02, 2, DISCOVERY_FPRD_TIMEOUT_US)
        except Exception:
            pass
        chip_model, family = _chip_from_identification_registers(esc_type, chip_id)
        chip_raw = b""
        if chip_model == "Generic ESC":
            try:
                chip_raw = slave._fprd(0x0E00, 4, DISCOVERY_FPRD_TIMEOUT_US)
            except Exception:
                # Some ESCs reject reads in the 0x0E00 area; the capability
                # signature below still identifies original vendor chips.
                pass
        try:
            capabilities = slave._fprd(0x0004, 3, DISCOVERY_FPRD_TIMEOUT_US)
        except Exception:
            capabilities = None
        if chip_model == "Generic ESC" and (capabilities is not None or chip_raw):
            chip_model, family = _chip_from_register(
                chip_raw,
                fmmu_count=capabilities[0] if capabilities is not None else None,
                sm_count=capabilities[1] if capabilities is not None else None,
                ram_kib=capabilities[2] if capabilities is not None else None,
            )
        return replace(
            basic,
            configured_address=configured_address,
            chip_model=chip_model,
            register_family=family,
            pdi_type=pdi_type,
        )

    def _read_eeprom_status(
        self, slave: Any, timeout_us: int = DISCOVERY_FPRD_TIMEOUT_US
    ) -> int:
        data = slave._fprd(0x0502, 2, timeout_us)
        if len(data) != 2:
            raise CommunicationError("EEPROM 状态寄存器读取不完整")
        return int.from_bytes(data, "little")

    def _eeprom_status_info(self, info: SlaveInfo, slave: Any) -> SlaveInfo:
        try:
            return replace(info, eeprom_status=self._read_eeprom_status(slave), eeprom_status_error=None)
        except Exception as exc:
            return replace(info, eeprom_status=None, eeprom_status_error=str(exc))

    def _read_eeprom_prefix(self, slave: Any, status: int) -> bytes:
        """Read only words 0..7 without SOEM's cached EEPROM ownership.

        pySOEM 1.1.13 eeprom_read() discards the low-level read result status.
        Use checked FPRD/FPWR here and restore ECAT/PDI ownership in finally.
        No EEPROM Write or Reload command is issued.
        """
        if status & 0x8000:
            raise CommunicationError("EEPROM 接口忙，未读取配置区")
        ownership = slave._fprd(0x0500, 2, DISCOVERY_FPRD_TIMEOUT_US)
        if len(ownership) != 2:
            raise CommunicationError("EEPROM 控制权读取不完整")
        restore = ownership[0] & 3
        if ownership[1] & 1:
            restore = (restore | 1) & ~2  # Offer control back to the PDI owner.
        size = 8 if status & 0x40 else 4
        result = bytearray()

        def wait_idle() -> int:
            deadline = time.monotonic() + 0.02
            while True:
                current = self._read_eeprom_status(slave)
                if not current & 0x8000:
                    return current
                if time.monotonic() >= deadline:
                    raise CommunicationError("EEPROM 读取超时")

        try:
            # Force ECAT access, then release the force bit (SOEM sequence).
            slave._fpwr(0x0500, b"\x02", DISCOVERY_FPRD_TIMEOUT_US)
            slave._fpwr(0x0500, b"\x00", DISCOVERY_FPRD_TIMEOUT_US)
            access = slave._fprd(0x0500, 2, DISCOVERY_FPRD_TIMEOUT_US)
            if len(access) != 2 or access[0] & 1 or access[1] & 1:
                raise CommunicationError("未取得 EEPROM 读取控制权")
            if wait_idle() & 0x6000:
                slave._fpwr(0x0502, b"\x00\x00", DISCOVERY_FPRD_TIMEOUT_US)
                if self._read_eeprom_status(slave) & 0x6000:
                    raise CommunicationError("EEPROM 命令错误未清除")
            for offset in range(0, 16, size):
                slave._fpwr(0x0504, (offset // 2).to_bytes(4, "little"), DISCOVERY_FPRD_TIMEOUT_US)
                slave._fpwr(0x0502, b"\x00\x01", DISCOVERY_FPRD_TIMEOUT_US)
                current = wait_idle()
                if current & 0x6000:
                    raise CommunicationError(f"EEPROM 读取失败，状态 0x{current:04X}")
                chunk = slave._fprd(0x0508, size, DISCOVERY_FPRD_TIMEOUT_US)
                if len(chunk) != size:
                    raise CommunicationError("EEPROM 配置区读取不完整")
                result.extend(chunk)
        finally:
            try:
                slave._fpwr(0x0500, bytes([restore]), DISCOVERY_FPRD_TIMEOUT_US)
                actual = slave._fprd(0x0500, 1, DISCOVERY_FPRD_TIMEOUT_US)
                if len(actual) != 1 or actual[0] & 3 != restore:
                    raise CommunicationError("EEPROM 控制权归还复核失败")
            except Exception as exc:
                raise CommunicationError(f"EEPROM 控制权归还失败：{exc}") from exc
        return bytes(result)

    def scan(
        self, on_discovered: Callable[[list[SlaveInfo]], None] | None = None
    ) -> list[SlaveInfo]:
        self._require_master()
        if self._passive is None or self._adapter_name is None:
            raise CommunicationError("被动发现通道不可用，请重新连接网卡")
        self._mapped = False
        self._mapping_attempted = False
        self._slaves = []
        try:
            discovered = passive_discover(self._adapter_name, transport=self._passive)
        except PassiveMediaDisconnected:
            discovered = []
        except (PassiveDiscoveryError, OSError) as exc:
            raise CommunicationError(f"扫描从站失败：{exc}") from exc
        self._slaves = [self._passive_info(item) for item in discovered]
        if on_discovered is not None:
            on_discovered(list(self._slaves))
        return list(self._slaves)

    def _passive_info(self, item: PassiveSlave) -> SlaveInfo:
        try:
            state = EtherCatState(item.state & 0x0F)
        except ValueError:
            state = EtherCatState.NONE
        chip_model, family = _chip_from_identification_registers(item.esc_type, item.chip_id)
        return SlaveInfo(
            item.position,
            item.name or f"Slave {item.position}",
            SlaveIdentity(*item.identity),
            state,
            item.al_status,
            item.sm_input_size,
            item.sm_output_size,
            configured_address=item.configured_address,
            chip_model=chip_model,
            register_family=family,
            raw_state=item.state,
            pdi_type=item.pdi_type,
            pdo_size_source="sm" if item.sm_input_size is not None or item.sm_output_size is not None else "unknown",
            esc_hardware=item.esc_hardware.hex(" ").upper() if item.esc_hardware else None,
            eeprom_status=item.eeprom_status,
            eeprom_prefix=item.eeprom_prefix.hex(" ").upper() if item.eeprom_prefix else None,
            eeprom_prefix_error=item.eeprom_prefix_error,
            product_type=item.product_type,
            product_model=item.product_model,
            sii_status=item.sii_status,
            sii_error=item.sii_error,
            eeprom_capacity=item.eeprom_capacity,
            identity_valid=item.identity_valid,
            scan_errors=item.scan_errors,
            state_error="AL 状态或状态码读取无效" if state is EtherCatState.NONE or any(
                "0x0130" in error or "0x0134" in error for error in item.scan_errors
            ) else None,
        )

    def read_states(self, refresh_eeprom: bool = False) -> list[SlaveInfo]:
        master = self._require_master()
        if not self._slaves:
            return []
        if self._passive is not None and self._slaves:
            try:
                states: list[SlaveInfo] = []
                for index, info in enumerate(self._slaves):
                    for attempt in range(3):
                        try:
                            raw, raw_wkc = self._passive.aprd(index + 1, 0x0130, 2)
                            code, code_wkc = self._passive.aprd(index + 1, 0x0134, 2)
                            if raw_wkc != 1 or code_wkc != 1 or len(raw) != 2 or len(code) != 2:
                                raise CommunicationError(f"从站 {index + 1} 状态读取 WKC 无效")
                            raw_state = int.from_bytes(raw, "little")
                            if (raw_state & 0x0F) not in {1, 2, 3, 4, 8}:
                                raise CommunicationError(f"从站 {index + 1} AL status 0x{raw_state:04X} 无效")
                            break
                        except (CommunicationError, PassiveDiscoveryError):
                            if attempt == 2:
                                raise
                            time.sleep(0.02)
                    states.append(replace(
                        info,
                        state=EtherCatState(raw_state & 0x0F),
                        raw_state=raw_state,
                        al_status=int.from_bytes(code, "little"),
                        state_error=None,
                    ))
                self._slaves = [self._sm_info(info) for info in states]
                if refresh_eeprom:
                    refreshed = []
                    for info in self._slaves:
                        try:
                            status = self._read_passive_register(info.position, 0x0502, 2)
                        except CommunicationError as exc:
                            refreshed.append(replace(info, eeprom_status=None, eeprom_status_error=str(exc)))
                        else:
                            refreshed.append(replace(info, eeprom_status=status, eeprom_status_error=None))
                    self._slaves = refreshed
                return list(self._slaves)
            except Exception as exc:
                raise CommunicationError(f"读取从站状态失败：{exc}") from exc
        self._ensure_operational()
        master.read_state()
        if len(self._slaves) != len(master.slaves):
            self._slaves = [self._info(i, slave) for i, slave in enumerate(master.slaves, 1)]
        else:
            refreshed: list[SlaveInfo] = []
            for cached, slave in zip(self._slaves, master.slaves, strict=True):
                try:
                    state = EtherCatState(int(slave.state) & 0x0F)
                except ValueError:
                    state = EtherCatState.NONE
                refreshed.append(replace(
                    cached, state=state, al_status=int(slave.al_status), raw_state=int(slave.state)
                ))
            self._slaves = refreshed
        if refresh_eeprom:
            self._slaves = [
                self._eeprom_status_info(info, slave)
                for info, slave in zip(self._slaves, master.slaves, strict=True)
            ]
        return list(self._slaves)

    def _read_passive_register(self, position: int, address: int, size: int) -> int:
        if self._passive is None:
            raise CommunicationError("被动状态控制通道不可用")
        try:
            data, wkc = self._passive.aprd(position, address, size)
        except PassiveDiscoveryError as exc:
            raise CommunicationError(f"从站 {position} 寄存器 0x{address:04X} 读取失败：{exc}") from exc
        if wkc != 1 or len(data) != size:
            raise CommunicationError(f"从站 {position} 寄存器 0x{address:04X} 读取 WKC 无效")
        return int.from_bytes(data, "little")

    def _sm_info(self, info: SlaveInfo) -> SlaveInfo:
        try:
            count = min(self._read_passive_register(info.position, 0x0005, 1), 16)
            data = self._read_passive_register(info.position, 0x0800, count * 8).to_bytes(count * 8, "little") if count else b""
            inputs, outputs = _sm_sizes(data) if count else (0, 0)
        except CommunicationError:
            return info
        return replace(info, input_size=inputs, output_size=outputs,
                       pdo_size_source="sm")

    def _mailbox_ready(self, position: int) -> bool:
        assert self._passive is not None
        try:
            data, wkc = self._passive.aprd(position, 0x0800, 16)
        except PassiveDiscoveryError as exc:
            raise CommunicationError(f"从站 {position} 邮箱 SM 读取失败：{exc}") from exc
        if wkc != 1 or len(data) != 16:
            raise CommunicationError(f"从站 {position} 邮箱 SM 读取 WKC 无效")
        return all(
            int.from_bytes(data[offset + 2:offset + 4], "little") > 0 and data[offset + 6] & 1
            for offset in (0, 8)
        )

    def _write_al_control(
        self, position: int, control: int, expected: EtherCatState, timeout_us: int, esc_config: int
    ) -> None:
        assert self._passive is not None
        try:
            self._passive.apwr(position, 0x0120, control.to_bytes(2, "little"))
        except PassiveDiscoveryError as exc:
            pending = ""
            if (esc_config & 1) == 0:
                try:
                    if self._read_passive_register(position, 0x0220, 2) & 1:
                        pending = "；PDI 尚未读取前一次 AL Control（0x0220[0]=1）"
                except CommunicationError:
                    pass
            raise CommunicationError(f"从站 {position} AL Control 写入失败：{exc}{pending}") from exc
        deadline = time.monotonic() + timeout_us / 1_000_000
        while True:
            raw = self._read_passive_register(position, 0x0130, 2)
            code = self._read_passive_register(position, 0x0134, 2)
            if raw == int(expected) and ((esc_config & 1) == 0 or code == 0):
                return
            if time.monotonic() >= deadline:
                raise CommunicationError(
                    f"从站 {position} 请求 {expected.label} 失败："
                    f"AL status 0x{raw:04X}, AL status code 0x{code:04X}, "
                    f"ESC configuration 0x{esc_config:02X} (device emulation {esc_config & 1})"
                )
            time.sleep(0.001)

    def request_state(
        self,
        position: int | None,
        state: EtherCatState,
        timeout_us: int,
        *,
        process_data: bool = True,
    ) -> list[SlaveInfo]:
        master = self._require_master()
        configurations: dict[int, int] = {}
        if self._passive is not None and self._slaves:
            positions = range(1, len(self._slaves) + 1) if position is None else (position,)
            positions = tuple(positions)
            for target_position in positions:
                if not 1 <= target_position <= len(self._slaves):
                    raise CommunicationError(f"从站 {target_position} 不可用")
                configurations[target_position] = self._read_passive_register(target_position, 0x0141, 1)
            emulated = all(config & 1 for config in configurations.values())
            direct_preop = (
                not process_data and state is EtherCatState.PRE_OP
                and all(
                    config & 1 or self._mailbox_ready(index)
                    # A pending AL event must be handled by the PDI before
                    # config_init can issue its own INIT request.
                    or self._read_passive_register(index, 0x0220, 2) & 1
                    for index, config in configurations.items()
                )
            )
            direct = (
                emulated and (not process_data or state in (EtherCatState.INIT, EtherCatState.PRE_OP))
            ) or (not process_data and (state in (EtherCatState.INIT, EtherCatState.OP) or direct_preop))
            if direct:
                if state in (EtherCatState.INIT, EtherCatState.PRE_OP):
                    self._invalidate_mapping()
                for target_position in positions:
                    config = configurations[target_position]
                    if (config & 1) == 0 and state in (EtherCatState.INIT, EtherCatState.PRE_OP):
                        raw = self._read_passive_register(target_position, 0x0130, 2)
                        if raw & 0x10:
                            self._write_al_control(
                                target_position, (raw & 0x0F) | 0x10,
                                EtherCatState(raw & 0x0F), timeout_us, config,
                            )
                    self._write_al_control(
                        target_position, int(state), state, timeout_us, config
                    )
                return self.read_states()
            if not master.slaves and not process_data and any(config & 1 for config in configurations.values()):
                raise CommunicationError("混合设备仿真与正常从站时，SOEM 广播初始化会改变仿真从站状态")
            if not master.slaves and not process_data and any(
                self._read_passive_register(index, 0x0141, 1) & 1
                for index in range(1, len(self._slaves) + 1) if index not in configurations
            ):
                raise CommunicationError("总线含设备仿真从站，SOEM 广播初始化会改变其状态")
        self._ensure_operational(manual_state_change=True)
        target = master if position is None else self._slave(position)
        master.read_state()
        if any((int(s.state) & 0x0F) in (0, 1) for s in master.slaves):
            self._invalidate_mapping()
        # Direct OP is an AL-control operation; do not turn its ErrorInd bit into
        # a PREOP acknowledgement cycle before writing the requested state.
        if process_data or state is not EtherCatState.OP:
            for index, slave in enumerate(master.slaves, 1):
                if (position is None or index == position) and not (configurations.get(index, 0) & 1):
                    self._acknowledge_error(slave, state, timeout_us)

        if state in (EtherCatState.INIT, EtherCatState.PRE_OP):
            self._invalidate_mapping()
        if process_data and state in (EtherCatState.SAFE_OP, EtherCatState.OP) and not self._mapped:
            self.map_process_data()
            target = master if position is None else self._slave(position)
        if state is EtherCatState.OP and process_data:
            self._transition(target, EtherCatState.SAFE_OP, timeout_us)
        self._transition(target, state, timeout_us, process_data=process_data)
        return self.read_states()

    def clear_error(self, position: int, timeout_us: int) -> list[SlaveInfo]:
        self._require_master()
        if self._passive is not None and self._slaves:
            if not 1 <= position <= len(self._slaves):
                raise CommunicationError(f"从站 {position} 不可用")
            esc_config = self._read_passive_register(position, 0x0141, 1)
            raw = self._read_passive_register(position, 0x0130, 2)
            code = self._read_passive_register(position, 0x0134, 2)
            if raw & 0x10 or (esc_config & 1 and code):
                try:
                    state = EtherCatState(raw & 0x0F)
                except ValueError as exc:
                    raise CommunicationError(f"从站 {position} AL status 0x{raw:04X} 无法确认") from exc
                control = int(state) if esc_config & 1 else int(state) | 0x10
                self._write_al_control(position, control, state, timeout_us, esc_config)
            return self.read_states()
        master = self._require_master()
        slave = self._slave(position)
        master.read_state()
        if int(slave.state) & 0x10:
            self._acknowledge_error(slave, EtherCatState(int(slave.state) & 0x0F), timeout_us)
        return self.read_states()

    def _acknowledge_error(self, slave: Any, state: EtherCatState, timeout_us: int) -> None:
        raw = int(slave.state)
        if raw & 0x10:
            logger.warning(
                "Acknowledging %s: AL state 0x%02X, code 0x%04X",
                slave.name, raw, int(slave.al_status),
            )
            original_error = self._state_transition_error(slave, state, raw, timeout_us)
            slave.state = (raw & 0x0F) | 0x10
            wkc = slave.write_state()
            if wkc is not None and wkc <= 0:
                raise CommunicationError(f"AL Control 错误确认写入失败，WKC={wkc}：{original_error}")
            deadline = time.monotonic() + timeout_us / 1_000_000
            while True:
                actual = self._check_state(slave, raw & 0x0F, min(1000, timeout_us))
                if actual == (raw & 0x0F) or (actual & 0x0F) != (raw & 0x0F):
                    break
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.001)
            if actual != (raw & 0x0F):
                raise CommunicationError(f"Error acknowledgement failed: {original_error}")

    def _transition(
        self, target: Any, state: EtherCatState, timeout_us: int, *, process_data: bool = True
    ) -> None:
        target.state = int(state)
        wkc = target.write_state()
        if wkc is not None and wkc <= 0:
            raise CommunicationError(f"请求 {state.label} 时 AL Control 写入失败，WKC={wkc}")
        if state is EtherCatState.OP and process_data:
            deadline = time.monotonic() + timeout_us / 1_000_000
            while True:
                snapshot = self.exchange_process_data(min(2000, timeout_us))
                actual = self._check_state(target, int(state), min(1000, timeout_us))
                if actual & 0x10:
                    break
                if actual == int(state) and snapshot.actual_wkc == snapshot.expected_wkc:
                    return
                if time.monotonic() >= deadline:
                    if actual == int(state):
                        raise CommunicationError(
                            f"OP process data WKC {snapshot.actual_wkc}, expected {snapshot.expected_wkc}"
                        )
                    break
        else:
            actual = self._check_state(target, int(state), timeout_us)
        if actual != int(state):
            error = self._state_transition_error(target, state, actual, timeout_us)
            # Keep the original transition failure if a follow-up state read
            # is unavailable. Diagnostics must never replace the root error.
            try:
                self.read_states()
            except Exception:
                pass
            raise error

    def _check_state(self, target: Any, expected: int, timeout_us: int) -> int:
        # SOEM returns only the low state nibble. The refreshed .state retains
        # ErrorInd; a broadcast check additionally needs individual slave reads.
        target.state_check(expected, timeout_us)
        if target is self._master:
            target.read_state()
            if not target.slaves:
                return 0
            return next((int(s.state) for s in target.slaves if int(s.state) != expected), expected)
        return int(target.state)

    def _state_transition_error(
        self, target: Any, requested: EtherCatState, actual: int, timeout_us: int
    ) -> CommunicationError:
        master = self._master
        if master is not None and target is master:
            candidates = list(getattr(master, "slaves", ()))
        else:
            candidates = [target]

        diagnostics: list[str] = []
        for index, slave in enumerate(candidates, 1):
            al_status = int(getattr(slave, "state", actual)) & 0xFFFF
            al_code = int(getattr(slave, "al_status", 0)) & 0xFFFF
            try:
                live_code = int.from_bytes(slave._fprd(0x0134, 2, min(timeout_us, 2000)), "little")
                al_code = live_code or (al_code if al_status & 0x10 else 0)
            except Exception:
                pass
            name = str(getattr(slave, "name", "")).strip() or f"slave {index}"
            detail = f"{name} AL status 0x{al_status:04X}"
            detail += f", AL status code 0x{al_code:04X}"
            detail += f" ({al_status_info(al_code).name})"
            if self._passive is not None and master is not None:
                position = next((number for number, item in enumerate(master.slaves, 1) if item is slave), index)
                try:
                    esc_config = self._read_passive_register(position, 0x0141, 1)
                    detail += f", ESC configuration 0x{esc_config:02X} (device emulation {esc_config & 1})"
                except CommunicationError:
                    pass
            diagnostics.append(detail)

        details = "; ".join(diagnostics) or "AL status unavailable"
        return CommunicationError(
            f"State transition to {requested.label} failed (actual 0x{actual:02X}; {details})"
        )

    def reconfig(self, position: int, timeout_us: int) -> bool:
        self._invalidate_mapping()
        return bool(self._slave(position).reconfig(timeout_us))

    def recover(self, position: int, timeout_us: int) -> bool:
        self._invalidate_mapping()
        return bool(self._slave(position).recover(timeout_us))

    @staticmethod
    def _normalize_error(exc: Exception, operation: str) -> CommunicationError:
        abort = getattr(exc, "abort_code", None)
        desc = getattr(exc, "desc", None) or getattr(exc, "message", None) or str(exc)
        suffix = f" (0x{abort:08X})" if abort is not None else ""
        return CommunicationError(f"{operation} failed{suffix}: {desc}")

    def sdo_read(self, position: int, index: int, subindex: int, size: int = 0) -> bytes:
        try:
            return self._slave(position).sdo_read(index, subindex, size=size, ca=False, release_gil=True)
        except Exception as exc:
            raise self._normalize_error(exc, f"SDO read 0x{index:04X}:{subindex:02X}") from exc

    def sdo_write(self, position: int, index: int, subindex: int, data: bytes) -> None:
        if 0x1600 <= index <= 0x1BFF or index in (0x1C12, 0x1C13):
            self._invalidate_mapping()
        try:
            self._slave(position).sdo_write(index, subindex, bytes(data), ca=False, release_gil=True)
        except Exception as exc:
            raise self._normalize_error(exc, f"SDO write 0x{index:04X}:{subindex:02X}") from exc

    def read_object_dictionary(self, position: int) -> list[ObjectDictionaryEntry]:
        result: list[ObjectDictionaryEntry] = []
        try:
            for obj in self._slave(position).od:
                entries = obj.entries
                for subindex, entry in enumerate(entries):
                    if entry.data_type > 0 and entry.bit_length > 0:
                        result.append(
                            ObjectDictionaryEntry(
                                obj.index,
                                subindex,
                                entry.name or obj.name,
                                entry.data_type,
                                entry.bit_length,
                                entry.obj_access,
                            )
                        )
        except Exception as exc:
            raise self._normalize_error(exc, "CoE SDO Info object dictionary") from exc
        return result

    def read_pdo_mapping(self, position: int, direction: PdoDirection) -> list[PdoEntry]:
        assignment = 0x1C12 if direction is PdoDirection.RX else 0x1C13
        count = int.from_bytes(self.sdo_read(position, assignment, 0), "little")
        result: list[PdoEntry] = []
        bit_offset = 0
        for assign_sub in range(1, count + 1):
            pdo_index = int.from_bytes(self.sdo_read(position, assignment, assign_sub), "little")
            entry_count = int.from_bytes(self.sdo_read(position, pdo_index, 0), "little")
            for entry_sub in range(1, entry_count + 1):
                value = int.from_bytes(self.sdo_read(position, pdo_index, entry_sub), "little")
                index, subindex, bits = (value >> 16) & 0xFFFF, (value >> 8) & 0xFF, value & 0xFF
                result.append(PdoEntry(direction, pdo_index, index, subindex, bits, bit_offset))
                bit_offset += bits
        return result

    def map_process_data(self) -> int:
        master = self._require_master()
        self._ensure_operational(manual_state_change=True)
        if self._mapped:
            return sum(len(slave.input) + len(slave.output) for slave in master.slaves)
        if self._mapping_attempted:
            # config_map appends FMMUs; config_init resets SOEM's allocation context.
            expected = [(s.identity.vendor_id, s.identity.product_code, s.identity.revision) for s in self._slaves]
            count = self._config_init(manual_state_change=True)
            actual = [(int(s.man), int(s.id), int(s.rev)) for s in master.slaves]
            if count != len(expected) or actual != expected:
                raise CommunicationError("PDO 重建时从站拓扑发生变化，请重新扫描总线")
        self.request_state(None, EtherCatState.PRE_OP, DEFAULT_STATE_TRANSITION_TIMEOUT_US)
        manual = master.manual_state_change
        try:
            # The caller explicitly requests SAFEOP after configuration succeeds.
            master.manual_state_change = True
            self._mapping_attempted = True
            size = int(master.config_map())
        except Exception as exc:
            raise self._normalize_error(exc, "PDO mapping") from exc
        finally:
            master.manual_state_change = manual
        self._mapped = True
        if self._passive is not None:
            self._slaves = [self._sm_info(info) for info in self._slaves]
            return size
        resolved: list[SlaveInfo] = []
        for info, slave in zip(self._slaves, master.slaves, strict=True):
            mapped_input = len(slave.input)
            mapped_output = len(slave.output)
            fallback_input = mapped_input == 0 and info.input_size not in (None, 0)
            fallback_output = mapped_output == 0 and info.output_size not in (None, 0)
            resolved.append(
                replace(
                    info,
                    input_size=info.input_size if fallback_input else mapped_input,
                    output_size=info.output_size if fallback_output else mapped_output,
                    pdo_size_source=(
                        info.pdo_size_source
                        if fallback_input or fallback_output
                        else "mapped"
                    ),
                )
            )
        self._slaves = resolved
        for info in self._slaves:
            self._pdo_size_cache[
                (info.identity.vendor_id, info.identity.product_code, info.identity.revision)
            ] = (info.input_size, info.output_size)
        return size

    def _invalidate_mapping(self) -> None:
        self._mapped = False
        self._slaves = [
            replace(info, pdo_size_source="cache")
            if info.pdo_size_source == "mapped" else info
            for info in self._slaves
        ]

    def exchange_process_data(self, timeout_us: int) -> ProcessDataSnapshot:
        master = self._require_master()
        if not self._mapped:
            raise CommunicationError("Process data is not mapped")
        master.send_processdata(release_gil=True)
        actual = int(master.receive_processdata(timeout_us, release_gil=True))
        expected = int(master.expected_wkc)
        self._cycle_count += 1
        if actual <= 0:
            self._timeouts += 1
        if actual != expected:
            self._wkc_errors += 1
            self._consecutive += 1
        else:
            self._consecutive = 0
        return ProcessDataSnapshot(
            tuple(s.input for s in master.slaves),
            tuple(s.output for s in master.slaves),
            actual,
            expected,
            self._cycle_count,
            self._timeouts,
            self._wkc_errors,
            self._consecutive,
            time.time(),
        )

    def set_output(self, position: int, data: bytes) -> None:
        slave = self._slave(position)
        expected = len(slave.output)
        if len(data) != expected:
            raise ValueError(f"Output must be exactly {expected} bytes")
        slave.output = bytes(data)

    def eeprom_read_block(
        self, position: int, word_address: int, byte_count: int
    ) -> EepromReadback:
        if byte_count <= 0 or byte_count % 2:
            raise ValueError("EEPROM read length must be a positive whole-word size")
        validate_eeprom_range(word_address, byte_count)
        self._require_master()
        if self._passive is not None and self._slaves:
            if not 1 <= position <= len(self._slaves):
                raise CommunicationError(f"从站 {position} 不可用")
            status: int | None = None
            try:
                data = self._passive.eeprom_read(position, word_address, byte_count // 2)
                if len(data) != byte_count:
                    raise CommunicationError("EEPROM 数据读取不完整")
                status = self._read_passive_register(position, 0x0502, 2)
                return EepromReadback(data, 1, status)
            except (PassiveDiscoveryError, CommunicationError) as exc:
                try:
                    status = self._read_passive_register(position, 0x0502, 2)
                except CommunicationError:
                    pass
                raise self._normalize_error(
                    exc,
                    f"EEPROM read word 0x{word_address:04X} "
                    f"(0x0502={f'0x{status:04X}' if status is not None else 'unavailable'})",
                ) from exc
        slave = self._slave(position)
        timeout_us = 20_000
        status: int | None = None
        restore: int | None = None
        active_word = word_address
        try:
            status = self._read_eeprom_status(slave, timeout_us)
            ownership = slave._fprd(0x0500, 2, timeout_us)
            if len(ownership) != 2:
                raise CommunicationError("EEPROM 控制权读取不完整")
            restore = ownership[0] & 3
            if ownership[1] & 1:
                restore = (restore | 1) & ~2
            slave._fpwr(0x0500, b"\x02", timeout_us)
            slave._fpwr(0x0500, b"\x00", timeout_us)
            access = slave._fprd(0x0500, 2, timeout_us)
            if len(access) != 2 or access[0] & 1 or access[1] & 1:
                raise CommunicationError("未取得 EEPROM 读取控制权")
            status = self._read_eeprom_status(slave, timeout_us)
            deadline = time.monotonic() + 0.02
            while status & 0x8000:
                if time.monotonic() >= deadline:
                    raise CommunicationError("EEPROM Busy 超时")
                status = self._read_eeprom_status(slave, timeout_us)
            if status & 0x6000:
                slave._fpwr(0x0502, b"\x00\x00", timeout_us)
                status = self._read_eeprom_status(slave, timeout_us)
                if status & 0x6000:
                    raise CommunicationError("EEPROM 错误位未清除")
            read_size = 8 if status & 0x40 else 4
            result = bytearray()
            while len(result) < byte_count:
                active_word = word_address + len(result) // 2
                slave._fpwr(0x0504, active_word.to_bytes(4, "little"), timeout_us)
                slave._fpwr(0x0502, b"\x00\x01", timeout_us)
                deadline = time.monotonic() + 0.02
                while True:
                    status = self._read_eeprom_status(slave, timeout_us)
                    if not status & 0x8000:
                        break
                    if time.monotonic() >= deadline:
                        raise CommunicationError("EEPROM Busy 超时")
                if status & 0x6000:
                    raise CommunicationError("EEPROM 命令或写保护错误")
                chunk_size = min(read_size, byte_count - len(result))
                chunk = slave._fprd(0x0508, chunk_size, timeout_us)
                if len(chunk) != chunk_size:
                    raise CommunicationError("EEPROM 数据回读不完整")
                result.extend(chunk)
            # pySOEM _fprd/_fpwr raise WkcError unless the actual WKC is exactly 1.
            return EepromReadback(bytes(result), 1, status)
        except Exception as exc:
            raise self._normalize_error(
                exc,
                f"EEPROM read word 0x{active_word:04X} (FPRD/FPWR WKC must equal 1; "
                f"0x0502={f'0x{status:04X}' if status is not None else 'unavailable'})",
            ) from exc
        finally:
            if restore is not None:
                try:
                    slave._fpwr(0x0500, bytes([restore]), timeout_us)
                    actual = slave._fprd(0x0500, 1, timeout_us)
                    if len(actual) != 1 or actual[0] & 3 != restore:
                        raise CommunicationError("EEPROM 控制权归还复核失败")
                except Exception as exc:
                    raise CommunicationError(f"EEPROM 控制权归还失败：{exc}") from exc

    def eeprom_read_checked(self, position: int, word_address: int) -> EepromReadback:
        return self.eeprom_read_block(position, word_address, 4)

    def eeprom_read(self, position: int, word_address: int) -> bytes:
        return self.eeprom_read_checked(position, word_address).data

    def eeprom_write(self, position: int, word_address: int, data: bytes) -> None:
        if len(data) != 2:
            raise ValueError("EEPROM writes are exactly one 16-bit word")
        validate_eeprom_range(word_address, len(data))
        self._require_master()
        if self._passive is not None and self._slaves:
            if not 1 <= position <= len(self._slaves):
                raise CommunicationError(f"从站 {position} 不可用")
            try:
                self._passive.eeprom_write(position, word_address, bytes(data))
            except PassiveDiscoveryError as exc:
                raise self._normalize_error(exc, f"EEPROM write word 0x{word_address:04X}") from exc
            return
        try:
            self._slave(position).eeprom_write(word_address, bytes(data))
        except Exception as exc:
            raise self._normalize_error(exc, f"EEPROM write word 0x{word_address:04X}") from exc

    def register_read(self, position: int, address: int, size: int, timeout_us: int) -> bytes:
        if not 1 <= size <= 256 or not 0 <= address <= 0xFFFF or address + size > 0x10000:
            raise ValueError("Register range is invalid")
        self._require_master()
        if self._passive is not None and self._slaves:
            if not 1 <= position <= len(self._slaves):
                raise CommunicationError(f"从站 {position} 不可用")
            try:
                data, wkc = self._passive.aprd(position, address, size)
            except PassiveDiscoveryError as exc:
                raise self._normalize_error(exc, f"APRD 0x{address:04X}") from exc
            if wkc != 1 or len(data) != size:
                raise CommunicationError(f"APRD 0x{address:04X} WKC={wkc}，读取长度 {len(data)}/{size}")
            return data
        try:
            return self._slave(position)._fprd(address, size, timeout_us)
        except Exception as exc:
            raise self._normalize_error(exc, f"FPRD 0x{address:04X}") from exc

    def register_write(self, position: int, address: int, data: bytes, timeout_us: int) -> None:
        if not data or not 0 <= address <= 0xFFFF or address + len(data) > 0x10000:
            raise ValueError("Register range is invalid")
        if address < 0x0900 and address + len(data) > 0x0600:
            self._invalidate_mapping()
        self._require_master()
        if self._passive is not None and self._slaves:
            if not 1 <= position <= len(self._slaves):
                raise CommunicationError(f"从站 {position} 不可用")
            try:
                self._passive.apwr(position, address, bytes(data))
            except PassiveDiscoveryError as exc:
                raise self._normalize_error(exc, f"APWR 0x{address:04X}") from exc
            return
        try:
            self._slave(position)._fpwr(address, bytes(data), timeout_us)
        except Exception as exc:
            raise self._normalize_error(exc, f"FPWR 0x{address:04X}") from exc
