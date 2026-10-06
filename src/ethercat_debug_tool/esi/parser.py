from __future__ import annotations

import hashlib
import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


class EsiValidationError(ValueError):
    pass


def parse_number(value: str | None, *, default: int | None = None) -> int:
    if value is None or not value.strip():
        if default is None:
            raise EsiValidationError("Required numeric value is missing")
        return default
    text = value.strip()
    if text.lower().startswith("#x"):
        return int(text[2:], 16)
    return int(text, 0)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if _local(child.tag) == name]


def _child(element: ET.Element, name: str) -> ET.Element | None:
    return next(iter(_children(element, name)), None)


def _text(element: ET.Element | None, default: str = "") -> str:
    return (element.text or "").strip() if element is not None else default


def _localized_name(element: ET.Element, fallback: str = "") -> str:
    names = _children(element, "Name")
    for preferred in (1033, 2052, 1031):
        for name in names:
            if parse_number(name.attrib.get("LcId"), default=0) == preferred and _text(name):
                return _text(name)
    return _text(names[0], fallback) if names else fallback


@dataclass(frozen=True, slots=True)
class EsiEntry:
    index: int
    subindex: int
    bit_length: int
    name: str
    data_type: str | None
    flags: int = 0


@dataclass(frozen=True, slots=True)
class EsiPdo:
    index: int
    name: str
    sync_manager: int | None
    entries: tuple[EsiEntry, ...]
    flags: int = 0
    dc_sync: int = 0


@dataclass(frozen=True, slots=True)
class EsiDcMode:
    name: str
    description: str
    assign_activate: int
    cycle_time_sync0: int
    shift_time_sync0: int
    cycle_time_sync1: int
    shift_time_sync1: int
    cycle_factor_sync0: int = 1
    cycle_factor_sync1: int = 1


@dataclass(frozen=True, slots=True)
class EsiSyncManager:
    start_address: int
    default_size: int
    control_byte: int
    enable: bool
    kind: str


@dataclass(frozen=True, slots=True)
class EsiObjectEntry:
    index: int
    subindex: int
    name: str
    data_type: str
    bit_length: int
    access: str


@dataclass(frozen=True, slots=True)
class EsiDevice:
    ordinal: int
    name: str
    type_name: str
    group_type: str
    vendor_id: int
    product_code: int
    revision: int
    serial_number: int
    byte_size: int
    config_data: bytes
    bootstrap: bytes
    fmmu: tuple[str, ...]
    sync_managers: tuple[EsiSyncManager, ...]
    rx_pdos: tuple[EsiPdo, ...]
    tx_pdos: tuple[EsiPdo, ...]
    dc_modes: tuple[EsiDcMode, ...]
    dpram_size: int | None
    fmmu_count: int | None
    sm_count: int | None
    physics: str
    coe_details: int
    mailbox_protocol: int
    general_flags: int
    objects: tuple[EsiObjectEntry, ...] = ()
    group_name: str = ""
    ds402_channels: int = 0
    sync_units: tuple[int, ...] = ()
    eeprom_mailbox: bytes | None = None
    eeprom_categories: tuple[tuple[int, bytes], ...] = ()
    soe_channels: int = 0
    ebus_current: int = 0
    identification_ado: int = 0


@dataclass(frozen=True, slots=True)
class EsiDocument:
    path: Path
    sha256: str
    vendor_id: int
    vendor_name: str
    devices: tuple[EsiDevice, ...]


class EsiParser:
    def parse(self, path: str | Path) -> EsiDocument:
        source = Path(path).resolve()
        try:
            raw = source.read_bytes()
            root = ET.fromstring(raw)
        except (OSError, ET.ParseError) as exc:
            raise EsiValidationError(f"Unable to parse ESI XML {source}: {exc}") from exc
        descriptions = next((node for node in root.iter() if _local(node.tag) == "Descriptions"), None)
        if descriptions is None:
            raise EsiValidationError("ESI XML does not contain Descriptions")
        vendor = _child(root, "Vendor")
        devices_node = _child(descriptions, "Devices")
        if vendor is None or devices_node is None:
            raise EsiValidationError("ESI XML must contain Vendor and Devices")
        vendor_id = parse_number(_text(_child(vendor, "Id")))
        vendor_name = _text(_child(vendor, "Name"), "Unknown vendor")
        # Preserve group declaration order for exact matching and TwinCAT's fallback.
        groups_node = _child(descriptions, "Groups")
        groups = {
            _text(_child(group, "Type")): _localized_name(group)
            for group in (_children(groups_node, "Group") if groups_node is not None else [])
        }
        devices = tuple(
            self._parse_device(i, element, vendor_id, groups)
            for i, element in enumerate(_children(devices_node, "Device"))
        )
        if not devices:
            raise EsiValidationError("ESI XML contains no Device definitions")
        return EsiDocument(source, hashlib.sha256(raw).hexdigest(), vendor_id, vendor_name, devices)

    # Retain the full ESC configuration and the metadata used by SII General.
    def _parse_device(
        self, ordinal: int, device: ET.Element, vendor_id: int, groups: dict[str, str]
    ) -> EsiDevice:
        type_element = _child(device, "Type")
        if type_element is None:
            raise EsiValidationError(f"Device {ordinal + 1} has no Type")
        type_name = _text(type_element)
        name = _localized_name(device, type_name)
        eeprom = _child(device, "Eeprom")
        if eeprom is None:
            raise EsiValidationError(f"Device {name} has no Eeprom section")
        byte_size = parse_number(_text(_child(eeprom, "ByteSize")))
        if byte_size <= 0 or byte_size % 2:
            raise EsiValidationError(f"Device {name} EEPROM ByteSize must be a positive even number")
        config_data = self._hex(_text(_child(eeprom, "ConfigData")), "ConfigData", name)
        if not 1 <= len(config_data) <= 14:
            raise EsiValidationError(f"Device {name} ConfigData must contain 1 to 14 bytes")
        bootstrap = self._hex(_text(_child(eeprom, "BootStrap")), "BootStrap", name, allow_empty=True)
        info = _child(device, "Info")
        controller = None
        if info is not None:
            controller = next((n for n in info.iter() if _local(n.tag) == "EtherCATController"), None)

        def ctl(name_: str) -> int | None:
            node = _child(controller, name_) if controller is not None else None
            return parse_number(_text(node), default=0) if node is not None else None

        # TwinCAT falls back to the first declared group when the reference is unmatched.
        group_type = _text(_child(device, "GroupType"))
        if group_type not in groups and groups:
            group_type = next(iter(groups))
        group_name = groups.get(group_type, "")
        mailbox_node = _child(eeprom, "Mailbox")
        mailbox_data = self._hex(_text(mailbox_node), "Mailbox", name, allow_empty=True) if mailbox_node is not None else None
        mailbox = _child(device, "Mailbox")
        soe = _child(mailbox, "SoE") if mailbox is not None else None
        electrical = _child(info, "Electrical") if info is not None else None
        identification = 0
        if info is not None:
            identification = (
                0x0134 if _text(_child(info, "IdentificationReg134")).lower() in {"true", "1"}
                else parse_number(_text(_child(info, "IdentificationAdo")), default=0)
            )

        return EsiDevice(
            ordinal,
            name,
            type_name,
            group_type,
            vendor_id,
            parse_number(type_element.attrib.get("ProductCode")),
            parse_number(type_element.attrib.get("RevisionNo")),
            parse_number(type_element.attrib.get("SerialNo"), default=0),
            byte_size,
            config_data,
            bootstrap,
            tuple(_text(x) for x in _children(device, "Fmmu")),
            tuple(self._parse_sm(x) for x in _children(device, "Sm")),
            tuple(self._parse_pdo(x) for x in _children(device, "RxPdo")),
            tuple(self._parse_pdo(x) for x in _children(device, "TxPdo")),
            self._dc_modes(device),
            ctl("DpramSize"),
            ctl("FmmuCount"),
            ctl("SmCount"),
            device.attrib.get("Physics", ""),
            *self._mailbox(device, info),
            self._objects(device),
            group_name,
            sum(
                parse_number(_text(node), default=0) == 402
                for profile in _children(device, "Profile")
                for node in profile.iter()
                if _local(node.tag) == "ProfileNo"
            ),
            self._sync_units(device),
            mailbox_data,
            self._eeprom_categories(eeprom, name),
            parse_number(soe.attrib.get("ChannelCount"), default=1) if soe is not None else 0,
            parse_number(_text(_child(electrical, "EBusCurrent") if electrical is not None else None), default=0),
            identification,
        )

    # Preserve explicit EEPROM categories ahead of generated categories, as TwinCAT does.
    def _eeprom_categories(self, eeprom: ET.Element, name: str) -> tuple[tuple[int, bytes], ...]:
        result = []
        for category in _children(eeprom, "Category"):
            kind = parse_number(_text(_child(category, "CatNo")))
            if not 0 <= kind < 0xFFFF:
                raise EsiValidationError(f"Device {name} has invalid EEPROM category number")
            payload = b""
            for node in category:
                field = _local(node.tag)
                if field == "Data":
                    payload = self._hex(_text(node), field, name, allow_empty=True)
                    # TwinCAT ignores odd-length raw category data rather than padding it.
                    if len(payload) % 2:
                        payload = b""
                elif field == "DataString":
                    payload = (node.text or "").encode("latin-1", errors="replace") + b"\x00"
                elif field in {"DataUINT", "DataUDINT"}:
                    width = 16 if field == "DataUINT" else 32
                    payload = struct.pack("<H" if width == 16 else "<I", parse_number(_text(node)) & ((1 << width) - 1))
                else:
                    continue
                break
            result.append((kind, payload))
        return tuple(result)

    # Preserve each declared sync unit's flags in XML order.
    @staticmethod
    def _sync_units(device: ET.Element) -> tuple[int, ...]:
        attributes = ("SeparateSu", "SeparateFrame", "DependOnInputState", "FrameRepeatSupport")
        # TwinCAT leaves the reserved high nibble set; absent attributes clear flags.
        return tuple(
            0xF0 | sum(
                1 << bit for bit, attribute in enumerate(attributes)
                if unit.attrib.get(attribute, "false").lower() in {"true", "1"}
            )
            for unit in _children(device, "Su")
        )

    @staticmethod
    def _objects(device: ET.Element) -> tuple[EsiObjectEntry, ...]:
        profile = _child(device, "Profile")
        if profile is None:
            return ()
        dictionary = _child(profile, "Dictionary")
        if dictionary is None:
            return ()
        data_types_node = _child(dictionary, "DataTypes")
        type_nodes = (
            {}
            if data_types_node is None
            else {_text(_child(node, "Name")): node for node in _children(data_types_node, "DataType")}
        )
        objects_node = _child(dictionary, "Objects")
        if objects_node is None:
            return ()
        result: list[EsiObjectEntry] = []
        for obj in _children(objects_node, "Object"):
            index = parse_number(_text(_child(obj, "Index")))
            type_name = _text(_child(obj, "Type"))
            data_type = type_nodes.get(type_name)
            subitems = _children(data_type, "SubItem") if data_type is not None else []
            if subitems:
                for sub in subitems:
                    flags = _child(sub, "Flags")
                    result.append(
                        EsiObjectEntry(
                            index,
                            parse_number(_text(_child(sub, "SubIdx")), default=0),
                            _text(_child(sub, "Name")),
                            _text(_child(sub, "Type")),
                            parse_number(_text(_child(sub, "BitSize")), default=0),
                            _text(_child(flags, "Access") if flags is not None else None, "unknown"),
                        )
                    )
            else:
                flags = _child(obj, "Flags")
                result.append(
                    EsiObjectEntry(
                        index,
                        0,
                        _text(_child(obj, "Name")),
                        type_name,
                        parse_number(_text(_child(obj, "BitSize")), default=0),
                        _text(_child(flags, "Access") if flags is not None else None, "unknown"),
                    )
                )
        return tuple(result)

    @staticmethod
    def _hex(text: str, field: str, device: str, allow_empty: bool = False) -> bytes:
        if not text and allow_empty:
            return b""
        try:
            return bytes.fromhex("".join(text.split()))
        except ValueError as exc:
            raise EsiValidationError(f"Device {device} has invalid {field} hex data") from exc

    @staticmethod
    def _parse_sm(element: ET.Element) -> EsiSyncManager:
        # SSC-generated ESI files spell the mailbox kinds as MBoxOut/MBoxIn;
        # canonicalise to the lowercase forms used across the SII generator.
        aliases = {"mboxout": "mailboxout", "mboxin": "mailboxin"}
        kind = _text(element)
        return EsiSyncManager(
            parse_number(element.attrib.get("StartAddress")),
            parse_number(element.attrib.get("DefaultSize"), default=0),
            parse_number(element.attrib.get("ControlByte")),
            element.attrib.get("Enable", "0") not in {"0", "false", "False"},
            aliases.get(kind.lower(), kind.lower()),
        )

    @staticmethod
    def _parse_pdo(element: ET.Element) -> EsiPdo:
        entries: list[EsiEntry] = []
        for entry in _children(element, "Entry"):
            index_node = _child(entry, "Index")
            flags = (
                0x1000
                if index_node is not None
                and index_node.attrib.get("DependOnSlot", "false").lower() in {"true", "1"}
                else 0
            )
            entries.append(
                EsiEntry(
                    parse_number(_text(_child(entry, "Index"))),
                    parse_number(_text(_child(entry, "SubIndex")), default=0),
                    parse_number(_text(_child(entry, "BitLen"))),
                    _localized_name(entry, ""),
                    _text(_child(entry, "DataType")) or None,
                    flags,
                )
            )
        sm_text = element.attrib.get("Sm")
        index_node = _child(element, "Index")
        flags = 0
        if element.attrib.get("Fixed", "false").lower() in {"true", "1"}:
            flags |= 0x0010
        if element.attrib.get("Mandatory", "false").lower() in {"true", "1"}:
            flags |= 0x0001
        if element.attrib.get("Virtual", "false").lower() in {"true", "1"}:
            flags |= 0x0020
        if index_node is not None and index_node.attrib.get("DependOnSlot", "false").lower() in {"true", "1"}:
            flags |= 0x0200
        return EsiPdo(
            parse_number(_text(_child(element, "Index"))),
            _localized_name(element, ""),
            parse_number(sm_text) if sm_text else None,
            tuple(entries),
            flags,
            parse_number(element.attrib.get("DcSync"), default=0),
        )

    @staticmethod
    def _dc_modes(device: ET.Element) -> tuple[EsiDcMode, ...]:
        dc = _child(device, "Dc")
        if dc is None:
            return ()
        result = []
        for mode in _children(dc, "OpMode"):

            def factor(name: str, mode: ET.Element = mode) -> int:
                node = _child(mode, name)
                return parse_number(node.attrib.get("Factor"), default=1) if node is not None else 1

            result.append(
                EsiDcMode(
                    _text(_child(mode, "Name")),
                    _text(_child(mode, "Desc")),
                    parse_number(_text(_child(mode, "AssignActivate")), default=0),
                    parse_number(_text(_child(mode, "CycleTimeSync0")), default=0),
                    parse_number(_text(_child(mode, "ShiftTimeSync0")), default=0),
                    parse_number(_text(_child(mode, "CycleTimeSync1")), default=0),
                    parse_number(_text(_child(mode, "ShiftTimeSync1")), default=0),
                    factor("CycleTimeSync0"),
                    factor("CycleTimeSync1"),
                )
            )
        return tuple(result)

    @staticmethod
    # Derive mailbox protocols and the independent General capability flags.
    def _mailbox(device: ET.Element, info: ET.Element | None) -> tuple[int, int, int]:
        mailbox = _child(device, "Mailbox")
        coe = _child(mailbox, "CoE") if mailbox is not None else None
        coe_details = 0
        if coe is not None:
            coe_details = 1
            for attribute, bit in (
                ("SdoInfo", 1),
                ("PdoAssign", 2),
                ("PdoConfig", 3),
                ("PdoUpload", 4),
                ("CompleteAccess", 5),
            ):
                if coe.attrib.get(attribute, "false").lower() in {"true", "1"}:
                    coe_details |= 1 << bit
        protocol = (1 << 2) if coe is not None else 0
        if mailbox is not None:
            for tag, bit in (("AoE", 0), ("EoE", 1), ("FoE", 3), ("SoE", 4), ("VoE", 5)):
                node = _child(mailbox, tag)
                if node is None:
                    continue
                # An AoE AdsRouter explicitly selects TwinCAT's AoE-capable device class.
                if tag == "AoE" and node.attrib.get("AdsRouter", "false").lower() not in {"true", "1"}:
                    continue
                if tag == "SoE" and parse_number(node.attrib.get("ChannelCount"), default=1) <= 0:
                    continue
                protocol |= 1 << bit
        flags = 0x04 if mailbox is not None and mailbox.attrib.get("DataLinkLayer", "false").lower() in {"true", "1"} else 0
        # TwinCAT's final General flags use Type attributes, independently of mailbox presence.
        type_node = _child(device, "Type")
        if type_node is not None:
            for attribute, bit in (("TcCfgModeSafeOp", 0), ("UseLrdLwr", 1)):
                if type_node.attrib.get(attribute, "false").lower() in {"true", "1"}:
                    flags |= 1 << bit
        if (
            info is not None
            and _text(_child(info, "IdentificationReg134")).lower() in {"true", "1"}
        ):
            flags |= 0x08
        elif info is not None:
            ado = parse_number(_text(_child(info, "IdentificationAdo")), default=0)
            if ado:
                flags |= 0x08 if ado == 0x0134 else 0x10
        return coe_details, protocol, flags
