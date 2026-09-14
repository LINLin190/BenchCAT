from __future__ import annotations

import struct
import time
from dataclasses import replace

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
from .base import CommunicationError


def _demo_eeprom(identity: SlaveIdentity, size: int = 2048) -> bytearray:
    data = bytearray(b"\xff" * size)
    header = bytearray(bytes.fromhex("900e80cc10270000000000000000"))
    crc = 0xFF
    for value in header:
        crc ^= value
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    data[:16] = header + bytes([crc, 0])
    data[0x10:0x20] = struct.pack(
        "<IIII", identity.vendor_id, identity.product_code, identity.revision, identity.serial_number
    )
    data[0x7C:0x80] = struct.pack("<HH", size // 128 - 1, 1)
    data[0x80:0x82] = struct.pack("<H", 0xFFFF)
    return data


class MockBackend:
    """Stateful deterministic backend used for demos and safe automated tests."""

    def __init__(self) -> None:
        self._connected = False
        self._mapped = False
        self._cycle_count = 0
        self._wkc_errors = 0
        self._timeouts = 0
        self._consecutive = 0
        identities = (
            SlaveIdentity(0x00001234, 0x00000001, 0x00010002, 0x18),
            SlaveIdentity(0x00001234, 0x00000002, 0x00010001, 0x25),
            SlaveIdentity(0x00001234, 0x00000003, 0x00010000, 0x31),
        )
        models = (
            ("E101", "ET1100_COMPATIBLE"),
            ("E252", "LAN9252_COMPATIBLE"),
            ("E253", "LAN9253_COMPATIBLE"),
        )
        self._slaves = [
            SlaveInfo(
                i + 1, f"Demo {model}", identity, EtherCatState.PRE_OP, 0, 6, 6, 0x1001 + i, model, family
            )
            for i, (identity, (model, family)) in enumerate(zip(identities, models, strict=True))
        ]
        self._inputs = [bytearray(6) for _ in self._slaves]
        self._outputs = [bytearray(6) for _ in self._slaves]
        self._eeprom = [_demo_eeprom(identity) for identity in identities]
        self._registers = [bytearray(0x10000) for _ in self._slaves]
        for i, slave in enumerate(self._slaves):
            self._registers[i][0x10:0x12] = slave.configured_address.to_bytes(2, "little")
            self._registers[i][0x130:0x132] = int(slave.state).to_bytes(2, "little")
            self._registers[i][0x134:0x136] = b"\x00\x00"
            hardware = ("4C 24 00 00 00 00 00 00", "01 00 52 92 25 00 00 00", "02 00 53 92 2D 68 00 00")
            self._registers[i][0x0E00:0x0E08] = bytes.fromhex(hardware[i])
        self._sdo: list[dict[tuple[int, int], bytes]] = []
        for slave in self._slaves:
            ident = slave.identity
            self._sdo.append(
                {
                    (0x1000, 0): (0x00020192).to_bytes(4, "little"),
                    (0x1008, 0): slave.name.encode("utf-8"),
                    (0x1018, 0): b"\x04",
                    (0x1018, 1): ident.vendor_id.to_bytes(4, "little"),
                    (0x1018, 2): ident.product_code.to_bytes(4, "little"),
                    (0x1018, 3): ident.revision.to_bytes(4, "little"),
                    (0x1018, 4): ident.serial_number.to_bytes(4, "little"),
                    (0x1C12, 0): b"\x01",
                    (0x1C12, 1): (0x1600).to_bytes(2, "little"),
                    (0x1C13, 0): b"\x01",
                    (0x1C13, 1): (0x1A00).to_bytes(2, "little"),
                    (0x1600, 0): b"\x02",
                    (0x1600, 1): (0x60400010).to_bytes(4, "little"),
                    (0x1600, 2): (0x607A0020).to_bytes(4, "little"),
                    (0x1A00, 0): b"\x02",
                    (0x1A00, 1): (0x60410010).to_bytes(4, "little"),
                    (0x1A00, 2): (0x60640020).to_bytes(4, "little"),
                    (0x6040, 0): b"\x06\x00",
                    (0x607A, 0): bytes(4),
                    (0x6041, 0): b"\x37\x12",
                    (0x6064, 0): bytes(4),
                }
            )

    @property
    def connected(self) -> bool:
        return self._connected

    def enumerate_adapters(self) -> list[AdapterInfo]:
        return [AdapterInfo("demo0", "Demo EtherCAT Adapter (no hardware writes)")]

    def connect(self, adapter_name: str) -> None:
        if adapter_name != "demo0":
            raise CommunicationError(f"Unknown demo adapter: {adapter_name}")
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False
        self._mapped = False

    def _check(self, position: int | None = None) -> None:
        if not self._connected:
            raise CommunicationError("Master is not connected")
        if position is not None and not 1 <= position <= len(self._slaves):
            raise CommunicationError(f"Slave {position} is not available")

    def scan(self) -> list[SlaveInfo]:
        self._check()
        self._slaves = [
            replace(info, esc_hardware=bytes(self._registers[i][0x0E00:0x0E00 + (2 if info.chip_model == "E101" else 8)]).hex(" ").upper())
            for i, info in enumerate(self._slaves)
        ]
        return list(self._slaves)

    def read_states(self) -> list[SlaveInfo]:
        self._check()
        return list(self._slaves)

    def request_state(self, position: int | None, state: EtherCatState, timeout_us: int) -> list[SlaveInfo]:
        self._check(position)
        targets = range(len(self._slaves)) if position is None else (position - 1,)
        for idx in targets:
            self._slaves[idx] = replace(self._slaves[idx], state=state, al_status=0)
            self._registers[idx][0x130:0x132] = int(state).to_bytes(2, "little")
        return list(self._slaves)

    def reconfig(self, position: int, timeout_us: int) -> bool:
        self._check(position)
        return True

    def recover(self, position: int, timeout_us: int) -> bool:
        self._check(position)
        return True

    def sdo_read(self, position: int, index: int, subindex: int, size: int = 0) -> bytes:
        self._check(position)
        try:
            data = self._sdo[position - 1][(index, subindex)]
        except KeyError as exc:
            raise CommunicationError(
                f"SDO abort 0x06020000: object 0x{index:04X}:{subindex:02X} does not exist"
            ) from exc
        return data if size == 0 else data[:size]

    def sdo_write(self, position: int, index: int, subindex: int, data: bytes) -> None:
        self._check(position)
        if (index, subindex) in {(0x1000, 0), (0x1018, 1), (0x1018, 2), (0x1018, 3)}:
            raise CommunicationError("SDO abort 0x06010002: object is read-only")
        self._sdo[position - 1][(index, subindex)] = bytes(data)

    def read_object_dictionary(self, position: int) -> list[ObjectDictionaryEntry]:
        self._check(position)
        return [
            ObjectDictionaryEntry(0x1000, 0, "Device type", "UDINT", 32, "ro"),
            ObjectDictionaryEntry(0x1018, 1, "Vendor ID", "UDINT", 32, "ro"),
            ObjectDictionaryEntry(0x6040, 0, "Controlword", "UINT", 16, "rw"),
            ObjectDictionaryEntry(0x6041, 0, "Statusword", "UINT", 16, "ro"),
            ObjectDictionaryEntry(0x6064, 0, "Position actual value", "DINT", 32, "ro"),
            ObjectDictionaryEntry(0x607A, 0, "Target position", "DINT", 32, "rw"),
        ]

    def read_pdo_mapping(self, position: int, direction: PdoDirection) -> list[PdoEntry]:
        self._check(position)
        if direction is PdoDirection.RX:
            return [
                PdoEntry(direction, 0x1600, 0x6040, 0, 16, 0, "Controlword", "UNSIGNED16"),
                PdoEntry(direction, 0x1600, 0x607A, 0, 32, 16, "Target position", "INTEGER32"),
            ]
        return [
            PdoEntry(direction, 0x1A00, 0x6041, 0, 16, 0, "Statusword", "UNSIGNED16"),
            PdoEntry(direction, 0x1A00, 0x6064, 0, 32, 16, "Position actual", "INTEGER32"),
        ]

    def map_process_data(self) -> int:
        self._check()
        self._mapped = True
        return sum(len(x) for x in self._inputs + self._outputs)

    def exchange_process_data(self, timeout_us: int) -> ProcessDataSnapshot:
        self._check()
        if not self._mapped:
            raise CommunicationError("Process data is not mapped")
        self._cycle_count += 1
        for idx, buf in enumerate(self._inputs):
            buf[0:2] = b"\x37\x12"
            buf[2:6] = (self._cycle_count * (idx + 1)).to_bytes(4, "little", signed=True)
        expected = len(self._slaves) * 3
        actual = expected
        self._consecutive = 0
        return ProcessDataSnapshot(
            tuple(map(bytes, self._inputs)),
            tuple(map(bytes, self._outputs)),
            actual,
            expected,
            self._cycle_count,
            self._timeouts,
            self._wkc_errors,
            self._consecutive,
            time.time(),
        )

    def set_output(self, position: int, data: bytes) -> None:
        self._check(position)
        target = self._outputs[position - 1]
        if len(data) != len(target):
            raise ValueError(f"Output must be exactly {len(target)} bytes")
        target[:] = data

    def eeprom_read(self, position: int, word_address: int) -> bytes:
        self._check(position)
        start = word_address * 2
        return bytes(self._eeprom[position - 1][start : start + 4]).ljust(4, b"\xff")

    def eeprom_write(self, position: int, word_address: int, data: bytes) -> None:
        self._check(position)
        if len(data) != 2:
            raise ValueError("EEPROM writes are exactly one 16-bit word")
        start = word_address * 2
        self._eeprom[position - 1][start : start + 2] = data

    def register_read(self, position: int, address: int, size: int, timeout_us: int) -> bytes:
        self._check(position)
        if not 1 <= size <= 256 or address < 0 or address + size > 0x10000:
            raise ValueError("Register range is invalid")
        return bytes(self._registers[position - 1][address : address + size])

    def register_write(self, position: int, address: int, data: bytes, timeout_us: int) -> None:
        self._check(position)
        if not data or address < 0 or address + len(data) > 0x10000:
            raise ValueError("Register range is invalid")
        if address == 0x0040 and data in (b"R", b"E", b"S"):
            return
        self._registers[position - 1][address : address + len(data)] = data
