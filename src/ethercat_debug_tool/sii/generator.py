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

    def generate(self, device: EsiDevice) -> SiiGenerationReport:
        capacity = device.byte_size
        if capacity < 128 or capacity % 128:
            raise ValueError("EEPROM ByteSize must be a positive multiple of 128")
        validate_eeprom_range(0, capacity)
        image = bytearray(b"\xff" * capacity)
        config = device.config_data[:10].ljust(10, b"\x00") + b"\x00" * 4
        image[:14] = config
        image[14] = crc8(config)
        image[15] = 0
        struct.pack_into(
            "<IIII", image, 0x10, device.vendor_id, device.product_code, device.revision, device.serial_number
        )
        image[0x20:0x28] = b"\x00" * 8
        # Bootstrap mailbox (words 0x14-0x17): receive offset/size and send
        # offset/size. The ESI BootStrap hex carries exactly these four fields.
        if device.bootstrap:
            image[0x28:0x30] = device.bootstrap[:8].ljust(8, b"\x00")
        else:
            image[0x28:0x30] = b"\x00" * 8
        # Standard mailbox (words 0x18-0x1B): receive from MBoxOut, send from
        # MBoxIn. SSC-style ESI files spell the kinds "MBoxOut"/"MBoxIn";
        # the parser canonicalises them to "mailboxout"/"mailboxin".
        for sm in device.sync_managers[:2]:
            if sm.kind == "mailboxout":
                struct.pack_into("<HH", image, 0x30, sm.start_address, sm.default_size)
            elif sm.kind == "mailboxin":
                struct.pack_into("<HH", image, 0x34, sm.start_address, sm.default_size)
        # Word 0x1C: standard mailbox protocols; word 0x1D: bootstrap protocols.
        struct.pack_into("<H", image, 0x38, device.mailbox_protocol)
        struct.pack_into("<H", image, 0x3A, device.mailbox_protocol if device.bootstrap else 0)
        image[0x3C:0x80] = b"\x00" * (0x80 - 0x3C)
        struct.pack_into("<HH", image, 0x7C, capacity // 128 - 1, 1)

        categories: list[tuple[int, bytes]] | None = None
        included_pdo = bool(device.tx_pdos or device.rx_pdos)
        included_dc = bool(device.dc_modes)
        included_entry_names = True
        last_error: Exception | None = None
        failed_attempts: list[tuple[bool, bool, bool, Exception]] = []
        # Descending fidelity ladder: full PDO names first, then PDO structure
        # without entry names (DC is functional while names are cosmetic, so
        # nameless PDO + DC outranks named PDO without DC), then no PDO, then
        # no DC. Keeps the most configuration-critical data within the
        # declared EEPROM capacity.
        attempts = [
            (True, True, True),
            (True, False, True),
            (True, True, False),
            (True, False, False),
            (False, True, True),
            (False, True, False),
        ]
        for include_pdo, include_entry_names, include_dc in attempts:
            try:
                candidate = self._categories(
                    device,
                    include_pdo=include_pdo,
                    include_dc=include_dc,
                    include_entry_names=include_entry_names,
                )
                encoded = self._encoded_size(candidate)
                if encoded + SiiParser.CATEGORY_START + 2 > capacity:
                    raise _SiiEncodingLimit(
                        f"encoded categories need {encoded} bytes plus the "
                        f"{SiiParser.CATEGORY_START + 2}-byte fixed area; capacity is {capacity}"
                    )
            except _SiiEncodingLimit as exc:
                last_error = exc
                failed_attempts.append((include_pdo, include_entry_names, include_dc, exc))
                continue
            categories = candidate
            included_pdo = include_pdo
            included_dc = include_dc
            included_entry_names = include_entry_names
            break
        if categories is None:
            raise ValueError(f"Unable to generate a capacity-safe SII image: {last_error}") from last_error

        offset = SiiParser.CATEGORY_START
        for kind, payload in categories:
            if len(payload) % 2:
                payload += b"\x00"
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
        if included_pdo:
            supported.append("PDO")
        if included_dc:
            supported.append("DC")
        omitted = [
            "vendor-specific categories",
            "EoE/FoE protocol-specific data",
            "explicit ESI DataTypes dictionary",
        ]
        if (device.tx_pdos or device.rx_pdos) and not included_pdo:
            omitted.append(self._pdo_omission_reason(device, capacity, failed_attempts))
        elif included_pdo and not included_entry_names:
            omitted.append(self._pdo_names_omission_reason(device, failed_attempts))
        if device.dc_modes and not included_dc:
            omitted.append("DC category (PDO takes precedence within the EEPROM capacity)")
        return SiiGenerationReport(result, tuple(supported), tuple(omitted))

    @staticmethod
    def _pdo_names_omission_reason(
        device: EsiDevice, failed_attempts: list[tuple[bool, bool, bool, Exception]]
    ) -> str:
        count = sum(len(pdo.entries) for pdo in (*device.tx_pdos, *device.rx_pdos))
        reason = next(
            (str(exc) for pdo, names, dc, exc in failed_attempts if pdo and names), "string table limit"
        )
        return f"PDO entry names omitted ({count} entries; {reason})"

    @staticmethod
    def _pdo_omission_reason(
        device: EsiDevice, capacity: int, failed_attempts: list[tuple[bool, bool, bool, Exception]]
    ) -> str:
        nameless = [exc for pdo, names, dc, exc in failed_attempts if pdo and not names]
        detail = str(nameless[0]) if nameless else str(failed_attempts[-1][3])
        return f"PDO categories omitted ({detail})"

    def _categories(
        self,
        device: EsiDevice,
        *,
        include_pdo: bool,
        include_dc: bool,
        include_entry_names: bool = True,
    ) -> list[tuple[int, bytes]]:
        strings = _Strings()
        group_index = strings.index(device.group_type)
        order_index = strings.index(device.type_name)
        name_index = strings.index(device.name)
        if include_pdo:
            for pdo in (*device.tx_pdos, *device.rx_pdos):
                strings.index(pdo.name)
                if include_entry_names:
                    for entry in pdo.entries:
                        strings.index(entry.name)
        if include_dc:
            for mode in device.dc_modes:
                strings.index(mode.name)
                strings.index(mode.description)

        categories: list[tuple[int, bytes]] = [(0x000A, strings.payload())]
        general = bytearray(32)
        general[0:4] = bytes([group_index, 0, order_index, name_index])
        general[5] = device.coe_details & 0xFF
        general[11:13] = struct.pack("<H", device.general_flags)
        general[16] = self._physical_port(device.physics)
        categories.append((0x001E, bytes(general)))
        if device.fmmu:
            mapping = {"outputs": 2, "inputs": 1, "mboxstate": 3}
            categories.append((0x0028, bytes(mapping.get(x.strip().lower(), 0) for x in device.fmmu)))
        if device.sync_managers:
            categories.append((0x0029, b"".join(self._sm(sm) for sm in device.sync_managers)))
        if device.mailbox_protocol:
            categories.append((0x002B, b"\xff\xff"))
        if include_pdo and device.tx_pdos:
            categories.append((0x0032, self._pdos(device.tx_pdos, strings, include_entry_names)))
        if include_pdo and device.rx_pdos:
            categories.append((0x0033, self._pdos(device.rx_pdos, strings, include_entry_names)))
        if include_dc and device.dc_modes:
            categories.append((0x003C, b"".join(self._dc(mode, strings) for mode in device.dc_modes)))
        return categories

    @staticmethod
    def _encoded_size(categories: list[tuple[int, bytes]]) -> int:
        return sum(4 + len(payload) + (len(payload) % 2) for _, payload in categories)

    @staticmethod
    def _physical_port(physics: str) -> int:
        mapping = {"Y": 1, "K": 2, "H": 3}
        value = 0
        # ESI lists physical ports 0,1,2,3; the SII descriptor stores 0,3,1,2.
        shifts = (0, 4, 6, 2)
        for index, character in enumerate(physics[:4]):
            value |= mapping.get(character.upper(), 0) << shifts[index]
        return value

    @staticmethod
    def _sm(sm: EsiSyncManager) -> bytes:
        sm_type = {"mailboxout": 1, "mailboxin": 2, "outputs": 3, "inputs": 4}.get(sm.kind, 0)
        return struct.pack(
            "<HHBBBB", sm.start_address, sm.default_size, sm.control_byte, 0, int(sm.enable), sm_type
        )

    @staticmethod
    def _entry(entry: EsiEntry, strings: _Strings, include_entry_names: bool) -> bytes:
        data_type = DATA_TYPES.get((entry.data_type or "").upper(), 0)
        name_index = strings.index(entry.name) if include_entry_names else 0
        return struct.pack(
            "<HBBBBH",
            entry.index,
            entry.subindex,
            name_index,
            data_type,
            entry.bit_length,
            entry.flags,
        )

    def _pdos(self, pdos: tuple[EsiPdo, ...], strings: _Strings, include_entry_names: bool) -> bytes:
        chunks = []
        for pdo in pdos:
            if len(pdo.entries) > 255:
                raise _SiiEncodingLimit(f"PDO 0x{pdo.index:04X} has more than 255 entries")
            sm = 0xFF if pdo.sync_manager is None else pdo.sync_manager
            chunks.append(
                struct.pack("<HBBHH", pdo.index, len(pdo.entries), sm, strings.index(pdo.name), pdo.flags)
            )
            chunks.extend(self._entry(entry, strings, include_entry_names) for entry in pdo.entries)
        return b"".join(chunks)

    @staticmethod
    def _dc(mode: EsiDcMode, strings: _Strings) -> bytes:
        return struct.pack(
            "<IHiIHiHBB",
            mode.cycle_time_sync0,
            mode.cycle_factor_sync0,
            mode.shift_time_sync0,
            mode.cycle_time_sync1,
            mode.cycle_factor_sync1,
            mode.shift_time_sync1,
            mode.assign_activate,
            strings.index(mode.name),
            strings.index(mode.description),
        )
