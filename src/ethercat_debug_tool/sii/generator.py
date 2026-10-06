from __future__ import annotations

import struct
from dataclasses import dataclass

from ..esi.parser import EsiDcMode, EsiDevice, EsiEntry, EsiPdo, EsiSyncManager
from .parser import SiiParser, crc8, validate_eeprom_range

DATA_TYPES = {
    "BOOL": 0x01,
    "SINT": 0x02,
    "INT": 0x03,
    "DINT": 0x04,
    "USINT": 0x05,
    "UINT": 0x06,
    "UDINT": 0x07,
    "REAL": 0x08,
    "STRING": 0x09,
    "LINT": 0x15,
    "ULINT": 0x1B,
    "LREAL": 0x11,
    "BIT1": 0x30,
    "BIT2": 0x31,
    "BIT3": 0x32,
    "BIT4": 0x33,
    "BIT5": 0x34,
    "BIT6": 0x35,
    "BIT7": 0x36,
    "BIT8": 0x37,
}


@dataclass(frozen=True, slots=True)
class SiiGenerationReport:
    image: bytes
    supported: tuple[str, ...]
    omitted: tuple[str, ...]


class _SiiEncodingLimit(ValueError):
    pass


class _Strings:
    def __init__(self) -> None:
        self.values: list[str] = []

    def index(self, value: str) -> int:
        if not value:
            return 0
        clean = value.encode("latin-1", errors="replace")[:255].decode("latin-1")
        if clean not in self.values:
            if len(self.values) >= 255:
                raise _SiiEncodingLimit("SII string table exceeds the 255-entry index limit")
            self.values.append(clean)
        return self.values.index(clean) + 1

    def payload(self) -> bytes:
        chunks = [bytes([len(self.values)])]
        for value in self.values:
            encoded = value.encode("latin-1")
            chunks.append(bytes([len(encoded)]) + encoded)
        return b"".join(chunks)


class SiiGenerator:
    """Converts the supported standard ESI subset into a complete SII image."""

    # Build a fixed-size image, dropping only complete optional categories.
    def generate(self, device: EsiDevice) -> SiiGenerationReport:
        capacity = device.byte_size
        if capacity < 128 or capacity % 128:
            raise ValueError("EEPROM ByteSize must be a positive multiple of 128")
        validate_eeprom_range(0, capacity)
        image = bytearray(b"\xff" * capacity)
        if not 1 <= len(device.config_data) <= 14:
            raise ValueError("ConfigData must contain 1 to 14 bytes")
        config = device.config_data.ljust(14, b"\x00")
        image[:14] = config
        image[14] = crc8(config)
        image[15] = 0
        struct.pack_into(
            "<IIII", image, 0x10, device.vendor_id, device.product_code, device.revision, device.serial_number
        )
        image[0x20:0x28] = b"\x00" * 8
        # Bootstrap mailbox (words 0x14-0x17): receive offset/size and send
        # offset/size. The ESI BootStrap hex carries exactly these four fields.
        image[0x28:0x38] = b"\x00" * 16
        if len(device.bootstrap) == 8:
            image[0x28:0x30] = device.bootstrap
        # Explicit EEPROM mailbox bytes take precedence over the first SM pair.
        if device.eeprom_mailbox is not None and len(device.eeprom_mailbox) == 8:
            image[0x30:0x38] = device.eeprom_mailbox
        elif device.eeprom_mailbox is None and len(device.sync_managers) >= 2:
            receive, send = device.sync_managers[:2]
            if receive.kind == "mailboxout" and send.kind == "mailboxin":
                struct.pack_into("<HHHH", image, 0x30, receive.start_address, receive.default_size,
                                 send.start_address, send.default_size)
        # Word 0x1C holds mailbox protocols; words 0x1D onward are reserved.
        struct.pack_into("<H", image, 0x38, device.mailbox_protocol)
        image[0x3A:0x80] = b"\x00" * (0x80 - 0x3A)
        struct.pack_into("<HH", image, 0x7C, capacity // 128 - 1, 1)

        categories: list[tuple[int, bytes]] | None = None
        included_pdo = bool(device.tx_pdos or device.rx_pdos)
        included_dc = bool(device.dc_modes)
        last_error: Exception | None = None
        included_custom = len(device.eeprom_categories)
        # Prefer DC when large PDO descriptions do not fit, as in TwinCAT images.
        # Rebuild strings so omitted categories leave no unused names behind.
        # Keep explicit categories first; if necessary remove complete trailing ones.
        for custom_count in range(len(device.eeprom_categories), -1, -1):
            for include_pdo, include_dc in ((True, True), (False, True), (True, False), (False, False)):
                try:
                    candidate = list(device.eeprom_categories[:custom_count]) + self._categories(
                        device,
                        include_pdo=include_pdo,
                        include_dc=include_dc,
                    )
                    encoded = self._encoded_size(candidate)
                    if encoded + SiiParser.CATEGORY_START + 2 > capacity:
                        raise _SiiEncodingLimit(
                            f"encoded categories need {encoded} bytes plus the "
                            f"{SiiParser.CATEGORY_START + 2}-byte fixed area; capacity is {capacity}"
                        )
                except _SiiEncodingLimit as exc:
                    last_error = exc
                    continue
                categories = candidate
                included_pdo = include_pdo and bool(device.tx_pdos or device.rx_pdos)
                included_dc = include_dc and bool(device.dc_modes)
                included_custom = custom_count
                break
            if categories is not None:
                break
        if categories is None:
            raise ValueError(f"Unable to generate a capacity-safe SII image: {last_error}") from last_error

        offset = SiiParser.CATEGORY_START
        for kind, payload in categories:
            if len(payload) % 2:
                payload += b"\xff"
            encoded = struct.pack("<HH", kind, len(payload) // 2) + payload
            image[offset : offset + len(encoded)] = encoded
            offset += len(encoded)
        image[offset : offset + 2] = b"\xff\xff"
        result = bytes(image)
        SiiParser().parse(result)
        supported = ["ConfigData header", "identity", "mailbox", "strings", "general"]
        if device.fmmu:
            supported.append("FMMU")
        if device.sync_managers:
            supported.append("SyncManager")
        if device.sync_units:
            supported.append("SyncUnit")
        if included_pdo:
            supported.append("PDO")
        if included_dc:
            supported.append("DC")
        if included_custom:
            supported.append("explicit EEPROM categories")
        omitted = [
            "EoE/FoE protocol-specific data",
            "explicit ESI DataTypes dictionary",
        ]
        if included_custom < len(device.eeprom_categories):
            omitted.append(f"Explicit EEPROM categories omitted (XML ByteSize {capacity})")
        if (device.tx_pdos or device.rx_pdos) and not included_pdo:
            omitted.append(f"PDO categories omitted (XML ByteSize {capacity})")
        if device.dc_modes and not included_dc:
            omitted.append(f"DC category omitted (XML ByteSize {capacity})")
        return SiiGenerationReport(result, tuple(supported), tuple(omitted))

    # Register only strings referenced by the selected complete categories.
    def _categories(
        self,
        device: EsiDevice,
        *,
        include_pdo: bool,
        include_dc: bool,
    ) -> list[tuple[int, bytes]]:
        strings = _Strings()
        order_index = strings.index(device.type_name)
        group_index = strings.index(device.group_type)
        group_name_index = strings.index(device.group_name or device.group_type)
        name_index = strings.index(device.name)
        if include_dc:
            for mode in device.dc_modes:
                strings.index(mode.name)
        if include_pdo:
            for pdo in (*device.tx_pdos, *device.rx_pdos):
                strings.index(pdo.name)
                for entry in pdo.entries:
                    strings.index(entry.name)

        categories: list[tuple[int, bytes]] = [(0x000A, strings.payload())]
        general = bytearray(32)
        general[0:4] = bytes([group_index, 0, order_index, name_index])
        # TwinCAT derives the compatibility byte from the physical-port descriptor.
        physical_port = self._physical_port(device.physics)
        general[4] = self._physical_type(physical_port)
        general[5] = device.coe_details & 0xFF
        general[6] = int(bool(device.mailbox_protocol & (1 << 3)))
        general[7] = int(bool(device.mailbox_protocol & (1 << 1)))
        general[8] = device.soe_channels & 0xFF
        general[9] = device.ds402_channels
        general[11] = device.general_flags & 0xFF
        # EBus current is a signed word; retain its two's-complement representation.
        struct.pack_into("<H", general, 12, device.ebus_current & 0xFFFF)
        general[14] = group_name_index
        struct.pack_into("<H", general, 16, physical_port)
        if device.identification_ado and device.identification_ado != 0x0134:
            struct.pack_into("<H", general, 18, device.identification_ado & 0xFFFF)
        categories.append((0x001E, bytes(general)))
        if device.fmmu:
            mapping = {"outputs": 1, "inputs": 2, "mboxstate": 3}
            categories.append((0x0028, bytes(mapping.get(x.strip().lower(), 0) for x in device.fmmu)))
        if device.sync_managers:
            categories.append((0x0029, b"".join(self._sm(sm) for sm in device.sync_managers)))
        # Emit SyncUnit only for explicit Su elements; odd payloads receive FF padding.
        if device.sync_units:
            categories.append((0x002B, bytes(device.sync_units)))
        if include_pdo and device.tx_pdos:
            categories.append((0x0032, self._pdos(device.tx_pdos, strings)))
        if include_pdo and device.rx_pdos:
            categories.append((0x0033, self._pdos(device.rx_pdos, strings)))
        if include_dc and device.dc_modes:
            categories.append((0x003C, b"".join(self._dc(mode, strings) for mode in device.dc_modes)))
        return categories

    @staticmethod
    def _encoded_size(categories: list[tuple[int, bytes]]) -> int:
        return sum(4 + len(payload) + (len(payload) % 2) for _, payload in categories)

    @staticmethod
    # General encodes each physical port in its own four-bit descriptor.
    def _physical_port(physics: str) -> int:
        mapping = {"Y": 1, "B": 2, "K": 3, "H": 4}
        # TwinCAT leaves an overlong Physics declaration empty instead of truncating it.
        if len(physics) > 4:
            return 0
        value = 0
        for index, character in enumerate(physics):
            value |= mapping.get(character.upper(), 0) << (index * 4)
        return value

    @staticmethod
    # Preserve the native TwinCAT physical-port classification, including its zero fallback.
    def _physical_type(ports: int) -> int:
        return {
            0x0001: 6, 0x0003: 11, 0x0011: 1, 0x0013: 10,
            0x0021: 13, 0x0022: 20, 0x0031: 3, 0x0032: 22, 0x0033: 12,
            0x0111: 4, 0x0131: 2, 0x0232: 21, 0x0311: 5,
            0x1111: 30, 0x1131: 31, 0x1311: 32, 0x1331: 34,
            0x3111: 33, 0x3131: 35, 0x3311: 36, 0x3331: 37,
        }.get(ports, 0)

    @staticmethod
    def _sm(sm: EsiSyncManager) -> bytes:
        sm_type = {"mailboxout": 1, "mailboxin": 2, "outputs": 3, "inputs": 4}.get(sm.kind, 0)
        return struct.pack(
            "<HHBBBB", sm.start_address, sm.default_size, sm.control_byte, 0, int(sm.enable), sm_type
        )

    @staticmethod
    # PDO entries contain single-byte string and data-type indices.
    def _entry(entry: EsiEntry, strings: _Strings) -> bytes:
        data_type = DATA_TYPES.get((entry.data_type or "").upper(), 0)
        name_index = strings.index(entry.name)
        return struct.pack(
            "<HBBBBH",
            entry.index,
            entry.subindex,
            name_index,
            data_type,
            entry.bit_length,
            entry.flags,
        )

    # The PDO header has separate byte-sized DC synchronization and name fields.
    def _pdos(self, pdos: tuple[EsiPdo, ...], strings: _Strings) -> bytes:
        chunks = []
        for pdo in pdos:
            if len(pdo.entries) > 255:
                raise _SiiEncodingLimit(f"PDO 0x{pdo.index:04X} has more than 255 entries")
            sm = 0xFF if pdo.sync_manager is None else pdo.sync_manager
            chunks.append(
                struct.pack(
                    "<HBBBBH", pdo.index, len(pdo.entries), sm, pdo.dc_sync,
                    strings.index(pdo.name), pdo.flags,
                )
            )
            chunks.extend(self._entry(entry, strings) for entry in pdo.entries)
        return b"".join(chunks)

    @staticmethod
    # SII DC records hold SYNC1 as a factor, followed by activation and SYNC0 factor.
    def _dc(mode: EsiDcMode, strings: _Strings) -> bytes:
        sync1_factor = mode.cycle_factor_sync1 if mode.assign_activate & 0x0400 else 0
        if mode.assign_activate & 0x0400 and mode.cycle_time_sync1:
            if not mode.cycle_time_sync0 or mode.cycle_time_sync1 % mode.cycle_time_sync0:
                raise _SiiEncodingLimit("DC SYNC1 period cannot be represented as a SII cycle factor")
            sync1_factor = mode.cycle_time_sync1 // mode.cycle_time_sync0
        if not -32768 <= sync1_factor <= 32767:
            raise _SiiEncodingLimit("DC SYNC1 cycle factor exceeds its signed 16-bit field")
        return struct.pack(
            "<IiihHhBB4x",
            mode.cycle_time_sync0,
            mode.shift_time_sync0,
            mode.shift_time_sync1,
            sync1_factor,
            mode.assign_activate,
            mode.cycle_factor_sync0 if not mode.cycle_time_sync0 else 0,
            strings.index(mode.name),
            0,
        )
