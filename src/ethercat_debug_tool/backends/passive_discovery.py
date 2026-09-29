from __future__ import annotations

import ctypes
import ctypes.util
import locale
import secrets
import struct
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from ..sii.parser import inspect_sii_header, validate_eeprom_range


class PassiveDiscoveryError(RuntimeError):
    """Raised when an EtherCAT register exchange cannot complete."""


class PassiveMediaDisconnected(PassiveDiscoveryError):
    """Raised when the network adapter has no physical link."""


class PassiveNoResponse(PassiveDiscoveryError):
    """Raised when no matching EtherCAT response arrives."""


# Windows ERROR_NDIS_MEDIA_DISCONNECTED (0x8034001F) in Npcap's error text.
_MEDIA_DISCONNECTED_CODE = b"(2150891551)"


def decode_native_text(value: bytes) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return value.decode(locale.getencoding(), errors="replace")


@dataclass(frozen=True, slots=True)
class PassiveSlave:
    position: int
    state: int
    al_status: int
    identity: tuple[int, int, int, int]
    configured_address: int | None
    pdi_type: int | None
    esc_type: bytes
    chip_id: bytes
    esc_hardware: bytes
    eeprom_status: int | None
    sm_input_size: int | None
    sm_output_size: int | None
    name: str | None = None
    product_type: str | None = None
    product_model: str | None = None
    eeprom_prefix: bytes | None = None
    eeprom_prefix_error: str | None = None
    sii_status: str = "unknown"
    sii_error: str | None = None
    eeprom_capacity: int | None = None
    identity_valid: bool | None = None
    scan_errors: tuple[str, ...] = ()


class _PcapPacketHeader(ctypes.Structure):
    _fields_ = [
        ("ts_sec", ctypes.c_long),
        ("ts_usec", ctypes.c_long),
        ("caplen", ctypes.c_uint),
        ("length", ctypes.c_uint),
    ]


class NpcapEthercatTransport:
    """Small Npcap EtherCAT transport for positional register access.

    Discovery uses register reads and EEPROM controller commands. Explicit
    state, EEPROM, and register actions also use this channel without PDOs.
    """

    def __init__(self, adapter_name: str, *, timeout_ms: int = 20) -> None:
        self.adapter_name = adapter_name
        self.timeout_ms = max(1, int(timeout_ms))
        self._pcap = None
        self._handle = ctypes.c_void_p()
        self._source = b"\x02" + secrets.token_bytes(5)
        self._index = 0

    def _load(self):
        if self._pcap is not None:
            return self._pcap
        loader = getattr(ctypes, "WinDLL", ctypes.CDLL)
        try:
            library = loader("wpcap.dll")
        except OSError as exc:
            path = ctypes.util.find_library("wpcap")
            if not path:
                raise PassiveDiscoveryError("未检测到 Npcap/wpcap.dll") from exc
            library = loader(path)
        library.pcap_open_live.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_char_p]
        library.pcap_open_live.restype = ctypes.c_void_p
        if hasattr(library, "pcap_open"):
            library.pcap_open.argtypes = [
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_void_p,
                ctypes.c_char_p,
            ]
            library.pcap_open.restype = ctypes.c_void_p
        library.pcap_sendpacket.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int]
        library.pcap_sendpacket.restype = ctypes.c_int
        library.pcap_next_ex.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(_PcapPacketHeader)), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
        library.pcap_next_ex.restype = ctypes.c_int
        library.pcap_close.argtypes = [ctypes.c_void_p]
        library.pcap_close.restype = None
        library.pcap_geterr.argtypes = [ctypes.c_void_p]
        library.pcap_geterr.restype = ctypes.c_char_p
        self._pcap = library
        return library

    def open(self) -> None:
        if self._handle.value:
            return
        library = self._load()
        error = ctypes.create_string_buffer(256)
        name = self.adapter_name.encode("utf-8")
        if hasattr(library, "pcap_open"):
            # Match SOEM's Windows driver: promiscuous, no local loopback,
            # maximum responsiveness, and an immediate packet wait.
            handle = library.pcap_open(name, 65535, 0x01 | 0x08 | 0x10, -1, None, error)
        else:
            handle = library.pcap_open_live(name, 65535, 1, self.timeout_ms, error)
        if not handle:
            detail = decode_native_text(error.value) or "未知错误"
            raise PassiveDiscoveryError(f"无法打开 EtherCAT 被动发现通道：{detail}")
        self._handle = ctypes.c_void_p(handle)

    def close(self) -> None:
        if self._handle.value and self._pcap is not None:
            self._pcap.pcap_close(self._handle)
        self._handle = ctypes.c_void_p()

    def __enter__(self) -> NpcapEthercatTransport:
        self.open()
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    @staticmethod
    def _frame(command: int, index: int, adp: int, ado: int, data: bytes, source: bytes = b"\x01" * 6) -> bytes:
        datagram = struct.pack("<BBHHHH", command, index, adp & 0xFFFF, ado & 0xFFFF, len(data), 0)
        datagram += data + b"\x00\x00"
        header = struct.pack("<H", 0x1000 | len(datagram))
        frame = b"\xff" * 6 + source + b"\x88\xa4" + header + datagram
        return frame + b"\x00" * max(0, 60 - len(frame))

    @staticmethod
    def _response(
        packet: bytes,
        request: bytes,
        command: int,
        index: int,
        length: int,
    ) -> tuple[bytes, int] | None:
        if len(packet) < 28 or packet[:14] != request[:14] or packet == request:
            return None
        header = struct.unpack_from("<H", packet, 14)[0]
        payload_length = header & 0x0FFF
        if header & 0xF000 != 0x1000 or payload_length != length + 12 or len(packet) < 16 + payload_length:
            return None
        offset = 16
        if packet[offset] != command or packet[offset + 1] != index:
            return None
        if packet[offset + 4:offset + 6] != request[offset + 4:offset + 6]:
            return None  # ADO must match; AP/BRD ADP changes while traversing slaves.
        if command in (0x04, 0x05) and packet[offset + 2:offset + 4] != request[offset + 2:offset + 4]:
            return None
        if struct.unpack_from("<H", packet, offset + 6)[0] & 0x8000:
            return None  # This transport sends one datagram per frame.
        datagram_length = struct.unpack_from("<H", packet, offset + 6)[0] & 0x07FF
        if datagram_length != length or datagram_length + 12 > payload_length:
            return None
        data_start = offset + 10
        data_end = data_start + length
        wkc = struct.unpack_from("<H", packet, data_end)[0]
        return packet[data_start:data_end], wkc

    def exchange(self, command: int, index: int, adp: int, ado: int, data: bytes) -> tuple[bytes, int]:
        self.open()
        self._index = (self._index + 1) & 0xFF
        index = self._index
        if index == 0:
            self._source = b"\x02" + secrets.token_bytes(5)
        request = self._frame(command, index, adp, ado, data, self._source)
        buffer = (ctypes.c_ubyte * len(request)).from_buffer_copy(request)
        if self._pcap.pcap_sendpacket(self._handle, buffer, len(request)) != 0:
            error = self._pcap.pcap_geterr(self._handle)
            if error and _MEDIA_DISCONNECTED_CODE in error:
                raise PassiveMediaDisconnected("网卡链路未连接")
            detail = decode_native_text(error) if error else "未知错误"
            raise PassiveDiscoveryError(f"发送 EtherCAT 读帧失败：{detail}")
        deadline = time.monotonic() + max(0.05, self.timeout_ms / 1000 * 3)
        while time.monotonic() < deadline:
            header_ptr = ctypes.POINTER(_PcapPacketHeader)()
            packet_ptr = ctypes.POINTER(ctypes.c_ubyte)()
            result = self._pcap.pcap_next_ex(self._handle, ctypes.byref(header_ptr), ctypes.byref(packet_ptr))
            if result == 0:
                continue
            if result < 0:
                error = self._pcap.pcap_geterr(self._handle)
                if error and _MEDIA_DISCONNECTED_CODE in error:
                    raise PassiveMediaDisconnected("网卡链路未连接")
                detail = decode_native_text(error) if error else "未知错误"
                raise PassiveDiscoveryError(f"读取 EtherCAT 响应帧失败：{detail}")
            packet = ctypes.string_at(packet_ptr, header_ptr.contents.caplen)
            response = self._response(packet, request, command, index, len(data))
            if response is not None:
                return response
        raise PassiveNoResponse(f"EtherCAT 0x{command:02X} 0x{ado:04X} 响应超时（无匹配帧）")

    def read(self, command: int, adp: int, ado: int, length: int) -> tuple[bytes, int]:
        return self.exchange(command, 0, adp, ado, bytes(length))

    def write(self, command: int, adp: int, ado: int, data: bytes) -> int:
        _, wkc = self.exchange(command, 0, adp, ado, bytes(data))
        return wkc

    def brd(self, address: int, length: int) -> tuple[bytes, int]:
        return self.read(0x07, 0, address, length)

    def aprd(self, position: int, address: int, length: int) -> tuple[bytes, int]:
        return self.read(0x01, 1 - position, address, length)

    def apwr(self, position: int, address: int, data: bytes) -> None:
        _, wkc = self.exchange(0x02, 0, 1 - position, address, bytes(data))
        if wkc != 1:
            raise PassiveDiscoveryError(f"APWR 0x{address:04X} 写入失败，WKC={wkc}")

    def fp_rd(self, position: int, address: int, length: int) -> bytes:
        data, wkc = self.read(0x04, position, address, length)
        if wkc != 1 or len(data) != length:
            raise PassiveDiscoveryError(f"FPRD 0x{address:04X} 读取失败，WKC={wkc}")
        return data

    def fp_wr(self, position: int, address: int, data: bytes) -> None:
        wkc = self.write(0x05, position, address, data)
        if wkc != 1:
            raise PassiveDiscoveryError(f"FPWR 0x{address:04X} 写入失败，WKC={wkc}")

    def _aprd_checked(self, position: int, address: int, size: int) -> bytes:
        data, wkc = self.aprd(position, address, size)
        if wkc != 1 or len(data) != size:
            raise PassiveDiscoveryError(f"APRD 0x{address:04X} WKC={wkc}，读取长度 {len(data)}/{size}")
        return data

    def _eeprom_idle(self, position: int) -> int:
        deadline = time.monotonic() + 0.1
        while True:
            status = int.from_bytes(self._aprd_checked(position, 0x0502, 2), "little")
            if not status & 0x8000:
                return status
            if time.monotonic() >= deadline:
                raise PassiveDiscoveryError(f"EEPROM Busy 超时，0x0502=0x{status:04X}")
            time.sleep(0.0002)

    @contextmanager
    def _eeprom_access(self, position: int) -> Iterator[None]:
        original = self._aprd_checked(position, 0x0500, 2)
        restore = 1 if original[0] & 1 or original[1] & 1 else 0
        self._eeprom_idle(position)
        operation_error: Exception | None = None
        try:
            self.apwr(position, 0x0500, b"\x02")
            self.apwr(position, 0x0500, b"\x00")
            deadline = time.monotonic() + 0.1
            while True:
                access = self._aprd_checked(position, 0x0500, 2)
                if not (access[0] & 1) and not (access[1] & 1):
                    break
                if time.monotonic() >= deadline:
                    raise PassiveDiscoveryError("未取得 EEPROM 控制权")
                time.sleep(0.0002)
            yield
        except Exception as exc:
            operation_error = exc
            raise
        finally:
            try:
                self.apwr(position, 0x0500, bytes([restore]))
                if self._aprd_checked(position, 0x0500, 1)[0] & 1 != restore:
                    raise PassiveDiscoveryError("EEPROM 控制权归还后读数不符")
            except Exception as exc:
                detail = f"{operation_error}；" if operation_error is not None else ""
                raise PassiveDiscoveryError(f"{detail}EEPROM 控制权归还失败：{exc}") from exc

    def _eeprom_command(self, position: int, word: int, data: bytes | None = None) -> int:
        for attempt in range(3):
            status = self._eeprom_idle(position)
            if status & 0x7800:
                self.apwr(position, 0x0502, b"\x00\x00")
                self._eeprom_idle(position)
            if data is not None:
                self.apwr(position, 0x0508, data)
            command = 0x0100 if data is None else 0x0201
            self.apwr(position, 0x0502, struct.pack("<HHH", command, word, 0))
            time.sleep(0.0002 if data is None else 0.0004)
            status = self._eeprom_idle(position)
            # Loading/CRC flags describe the old SII; they must not prohibit repair.
            if not status & 0x6000:
                return status
            if status & 0x2000 and not status & 0x4000 and attempt < 2:
                time.sleep(0.001)
                continue
            raise PassiveDiscoveryError(f"EEPROM word 0x{word:04X} 命令失败，0x0502=0x{status:04X}")
        raise AssertionError("unreachable")

    def eeprom_read(self, position: int, start_word: int, word_count: int) -> bytes:
        validate_eeprom_range(start_word, word_count * 2)
        with self._eeprom_access(position):
            result = bytearray()
            first_word = start_word & ~1
            for word in range(first_word, start_word + word_count, 2):
                self._eeprom_command(position, word)
                result.extend(self._aprd_checked(position, 0x0508, 4))
            offset = (start_word - first_word) * 2
            return bytes(result[offset : offset + word_count * 2])

    def eeprom_write(self, position: int, word_address: int, data: bytes) -> None:
        if len(data) != 2:
            raise ValueError("EEPROM writes are exactly one 16-bit word")
        validate_eeprom_range(word_address, len(data))
        with self._eeprom_access(position):
            self._eeprom_command(position, word_address, data)


def _u16(data: bytes, offset: int = 0) -> int:
    return int.from_bytes(data[offset : offset + 2], "little")


def _u32(data: bytes, offset: int = 0) -> int:
    return int.from_bytes(data[offset : offset + 4], "little")


def _sm_sizes(data: bytes) -> tuple[int | None, int | None]:
    input_size = 0
    output_size = 0
    for sm_index in range(len(data) // 8):
        base = sm_index * 8
        length = _u16(data, base + 2)
        control = data[base + 4]
        if not (data[base + 6] & 1) or not length or control & 3 == 2:
            continue
        if control & 0x0C == 0:
            input_size += length
        elif control & 0x0C == 4:
            output_size += length
    return (input_size, output_size) if data else (None, None)


def _sii_summary(
    data: bytes, capacity: int | None = None,
) -> tuple[str | None, str | None]:
    strings: tuple[str, ...] = ()
    general = b""
    offset = 0
    while offset + 2 <= len(data):
        kind = _u16(data, offset)
        if kind == 0xFFFF:
            break
        if offset + 4 > len(data):
            if capacity is not None and len(data) + 0x80 >= capacity:
                raise ValueError("SII Category 头部不完整")
            break
        words = _u16(data, offset + 2)
        payload_end = offset + 4 + words * 2
        if capacity is not None and payload_end + 0x80 > capacity:
            raise ValueError(f"SII Category 0x{kind:04X} 超出声明容量")
        if payload_end > len(data):
            break
        payload = data[offset + 4 : payload_end]
        if kind == 0x000A and payload:
            parsed: list[str] = []
            cursor = 1
            for _ in range(payload[0]):
                if cursor >= len(payload):
                    raise ValueError("SII Strings 类别不完整")
                length = payload[cursor]
                cursor += 1
                if cursor + length > len(payload):
                    raise ValueError("SII String 长度超出类别边界")
                parsed.append(payload[cursor : cursor + length].decode("latin-1", errors="replace"))
                cursor += length
            strings = tuple(parsed)
        elif kind == 0x001E:
            general = payload
        offset = payload_end
    else:
        if capacity is not None and len(data) + 0x80 >= capacity:
            raise ValueError("SII Category 缺少结束标记")

    def string(index: int) -> str | None:
        return strings[index - 1] if 0 < index <= len(strings) else None

    product_type = string(general[0]) if len(general) >= 1 else None
    product_model = string(general[2]) or string(general[3]) if len(general) >= 4 else None
    return product_type, product_model


def discover(adapter_name: str, *, transport: NpcapEthercatTransport | None = None) -> list[PassiveSlave]:
    owned = transport is None
    channel = transport or NpcapEthercatTransport(adapter_name)
    try:
        channel.open()
        try:
            _, count = channel.brd(0x0000, 2)
        except PassiveNoResponse:
            return []
        result: list[PassiveSlave] = []
        for position in range(1, count + 1):
            errors: list[str] = []

            def read(
                address: int, size: int, *, required: bool = False,
                position: int = position, errors: list[str] = errors,
            ) -> bytes:
                try:
                    data, wkc = channel.aprd(position, address, size)
                    if wkc != 1 or len(data) != size:
                        raise PassiveDiscoveryError(f"WKC={wkc}，长度 {len(data)}/{size}")
                    return data
                except PassiveMediaDisconnected:
                    raise
                except PassiveDiscoveryError as exc:
                    detail = f"从站 {position} 0x{address:04X}：{exc}"
                    if required:
                        raise PassiveDiscoveryError(detail) from exc
                    errors.append(detail)
                    return b""

            esc_type = read(0x0000, 2, required=True)
            state_data = read(0x0130, 2)
            if state_data and (_u16(state_data) & 0x0F) not in (1, 2, 3, 4, 8):
                errors.append(f"AL 状态值无效：0x{_u16(state_data):04X}")
            al_code = read(0x0134, 2)
            configured = read(0x0010, 2)
            pdi = read(0x0140, 1)
            chip_id = read(0x0E02, 2) if esc_type[0] != 0x11 else b""
            hardware = read(0x0E00, 8)
            sm_count = read(0x0005, 1)
            sm_data = read(0x0800, min(sm_count[0], 16) * 8) if sm_count and sm_count[0] else b""
            sm_input_size, sm_output_size = (0, 0) if sm_count == b"\x00" else _sm_sizes(sm_data)
            product_type = None
            product_model = None
            eeprom_prefix = None
            eeprom_prefix_error = None
            identity = (0, 0, 0, 0)
            identity_valid = False
            sii_status, sii_error, capacity = "unreadable", None, None
            try:
                fixed = channel.eeprom_read(position, 0, 64)
                if len(fixed) != 128:
                    raise PassiveDiscoveryError("EEPROM 固定区读取不完整")
                eeprom_prefix = fixed[:16]
                header = inspect_sii_header(fixed)
                sii_status, sii_error, capacity = header.status, header.error, header.capacity
                identity_valid = header.identity_valid
                if identity_valid:
                    identity = tuple(_u32(fixed, offset) for offset in (0x10, 0x14, 0x18, 0x1C))
            except PassiveDiscoveryError as exc:
                eeprom_prefix_error = sii_error = str(exc)
            try:
                category_words = min(max(capacity // 2 - 0x40, 0), 256) if capacity else 0
                if category_words:
                    categories = channel.eeprom_read(position, 0x40, category_words)
                    if len(categories) != category_words * 2:
                        raise PassiveDiscoveryError("SII Category 读取不完整")
                    product_type, product_model = _sii_summary(categories, capacity)
            except (PassiveDiscoveryError, ValueError) as exc:
                sii_status, sii_error = "invalid", f"SII Category 读取/解析失败：{exc}"
            eeprom_status_data = read(0x0502, 2)
            result.append(
                PassiveSlave(
                    position,
                    _u16(state_data),
                    _u16(al_code),
                    identity,
                    _u16(configured) if len(configured) == 2 else None,
                    pdi[0] if pdi else None,
                    esc_type,
                    chip_id,
                    hardware,
                    _u16(eeprom_status_data) if len(eeprom_status_data) == 2 else None,
                    sm_input_size,
                    sm_output_size,
                    product_model or product_type,
                    product_type,
                    product_model,
                    eeprom_prefix,
                    eeprom_prefix_error,
                    sii_status,
                    sii_error,
                    capacity,
                    identity_valid,
                    tuple(errors),
                )
            )
        return result
    finally:
        if owned:
            channel.close()
