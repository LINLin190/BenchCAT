from __future__ import annotations

import copy
import json
import re
import threading
from dataclasses import dataclass
from enum import StrEnum
from functools import cached_property
from importlib.resources import files
from typing import Any


class RegisterFamily(StrEnum):
    ET1100_COMPATIBLE = "ET1100_COMPATIBLE"
    LAN9252_COMPATIBLE = "LAN9252_COMPATIBLE"
    LAN9253_COMPATIBLE = "LAN9253_COMPATIBLE"
    GENERIC = "GENERIC"


@dataclass(frozen=True, slots=True)
class EscProfile:
    chip_model: str
    register_family: RegisterFamily
    manufacturer: str
    pram_start: int | None
    pram_end: int | None
    fixed_fmmu_count: int | None
    fixed_sm_count: int | None
    reset_supported: bool
    reset_register: int = 0x0040
    reset_sequence: bytes = b"RES"
    documentation: str = ""
    limitations: tuple[str, ...] = ()


_ADDRESS_SPACES = {
    "ESC Core CSR": "esc_core",
    "LAN925x System CSR": "lan925x_system_csr",
    "HBI local register": "hbi_local",
    "Integrated PHY register": "phy",
    "Process Data RAM": "process_ram",
    "User RAM": "user_ram",
}
_FAMILY_SOURCE = {
    "E101": "ET1100", "ET1100": "ET1100",
    "E252": "LAN9252", "LAN9252": "LAN9252",
    "E253": "LAN9253", "LAN9253": "LAN9253",
}
_ADDRESS = re.compile(r"^0x([0-9A-Fa-f]+)(?:-0x[0-9A-Fa-f]+)?$")


class ProfileRegistry:
    """Profile-scoped ESC register definitions from the investigation bundle.

    Local-only LAN925x areas remain visible as documentation, but their address
    space/access metadata prevents the EtherCAT master bridge from using them.
    """

    def __init__(self) -> None:
        self._profiles = {
            "E101": EscProfile("E101", RegisterFamily.ET1100_COMPATIBLE, "国产", 0x1000, 0x2FFF, 8, 8, True, documentation="按 ET1100 完整同构处理"),
            "E252": EscProfile("E252", RegisterFamily.LAN9252_COMPATIBLE, "国产", 0x1000, 0x1FFF, 3, 4, True, documentation="按 LAN9252 完整同构处理"),
            "E253": EscProfile("E253", RegisterFamily.LAN9253_COMPATIBLE, "国产", 0x1000, 0x2FFF, 8, 8, True, documentation="按 LAN9253 完整同构处理"),
            "ET1100": EscProfile("ET1100", RegisterFamily.ET1100_COMPATIBLE, "Beckhoff", 0x1000, 0x2FFF, 8, 8, True, documentation="ET1100 EtherCAT Slave Controller documentation"),
            "LAN9252": EscProfile("LAN9252", RegisterFamily.LAN9252_COMPATIBLE, "Microchip", 0x1000, 0x1FFF, 3, 4, True, documentation="Microchip LAN9252 datasheet"),
            "LAN9253": EscProfile("LAN9253", RegisterFamily.LAN9253_COMPATIBLE, "Microchip", 0x1000, 0x2FFF, 8, 8, True, documentation="Microchip LAN9253 datasheet"),
            "Generic ESC": EscProfile("Generic ESC", RegisterFamily.GENERIC, "Unknown", None, None, None, None, False, limitations=("仅提供 EtherCAT 公共寄存器和原始访问",)),
        }
        self._catalog_lock = threading.RLock()
        self._catalog_cache: dict[tuple[str, int, int], list[dict[str, Any]]] = {}
        self._summary_cache: dict[tuple[str, int, int], list[dict[str, Any]]] = {}

    def get(self, chip_model: str) -> EscProfile:
        return self._profiles.get(chip_model, self._profiles["Generic ESC"])

    def resolve(self, *, esi_type: str | None = None, chip_register: bytes | None = None) -> EscProfile:
        candidates = " ".join(filter(None, (esi_type, chip_register.rstrip(b"\x00").decode("ascii", errors="ignore") if chip_register else None))).upper()
        for name in ("E101", "E252", "E253", "LAN9252", "LAN9253", "ET1100"):
            if name in candidates:
                return self._profiles[name]
        if chip_register:
            value = int.from_bytes(chip_register, "little")
            for name in ("E101", "E252", "E253"):
                if value == int(name, 16):
                    return self._profiles[name]
        return self._profiles["Generic ESC"]

    @cached_property
    def _database(self) -> dict[str, Any]:
        resource = files("ethercat_debug_tool.esc_profiles.data").joinpath("esc_register_database.json")
        return json.loads(resource.read_text(encoding="utf-8"))

    @staticmethod
    def _start_address(value: str) -> int:
        match = _ADDRESS.match(value)
        if match:
            return int(match.group(1), 16)
        # PHY templates use MII device.register notation rather than a linear
        # ESC address. They are documentation-only in this bridge, so retain
        # the original address_text and use the device part only as a display
        # sort key; definition_id remains the unambiguous identity.
        try:
            return int(value.split(".", 1)[0], 10)
        except ValueError as exc:
            raise ValueError(f"Unsupported investigated register address: {value}") from exc

    @cached_property
    def _hardware_fields(self) -> dict[str, list[dict[str, Any]]]:
        resource = files("ethercat_debug_tool.esc_profiles.data").joinpath("esc_hardware_fields.json")
        return json.loads(resource.read_text(encoding="utf-8"))

    @staticmethod
    def _write_semantics(master_access: str, fields: list[dict[str, Any]], has_write_effect: bool) -> str:
        # Write-any-to-clear counters differ from bit masks cleared by writing one.
        if master_access in {"WAC", "W1C", "W1S"}:
            return master_access
        if master_access in {"RO", "R", "RO_READ_SIDE_EFFECT"}:
            return "RO"
        if master_access == "RO_WITH_ACK_SEMANTIC":
            return "WAC" if has_write_effect else "RO"
        if master_access in {"RW", "WO"}:
            return master_access
        field_accesses = {str(field.get("ecat_access", "")) for field in fields}
        if field_accesses == {"W1C"}:
            return "W1C"
        if field_accesses == {"W1S"}:
            return "W1S"
        if field_accesses == {"WAC"}:
            return "WAC"
        return "MIXED"

    @staticmethod
    def _dangerous(record: dict[str, Any], address_space: str, semantic: str) -> bool:
        category = str(record.get("category", "")).lower()
        return (
            address_space != "esc_core"
            or semantic not in {"RW", "W1C", "W1S", "WAC", "WO"}
            or any(token in category for token in ("reset", "pdi", "syncmanager", "distributed clock", "eeprom"))
            or (bool(record.get("write_side_effects")) and semantic not in {"W1C", "W1S", "WAC"})
            or str(record.get("state_restriction", "not documented")) != "not documented"
        )

    @staticmethod
    def _compact_field(field: dict[str, Any]) -> dict[str, Any]:
        bits = str(field.get("bits", "0"))
        high, _, low = bits.partition(":")
        try:
            upper, lower = int(high, 10), int(low or high, 10)
        except ValueError:
            upper = lower = 0
        return {
            "name": field.get("name", "Unnamed field"), "shift": min(lower, upper),
            "bits": abs(upper - lower) + 1, "access": field.get("ecat_access") or field.get("access"),
            "reserved": bool(field.get("reserved")), "description": field.get("description", ""),
        }

    def _definition(self, profile: str, record: dict[str, Any]) -> dict[str, Any]:
        address_space = _ADDRESS_SPACES.get(str(record.get("address_space")), "unknown")
        source_fields = (
            self._hardware_fields[record["fields_source"]]
            if "fields_source" in record else record.get("fields", [])
        )
        fields = [dict(field) for field in source_fields]
        # Hardware pin tables use ordered labels; expose explicit values to the register decoder.
        for field in fields:
            enums = field.get("enum_values", [])
            if enums and isinstance(enums[0], str):
                field["enum_values"] = [{"value": str(index), "meaning": label} for index, label in enumerate(enums)]
        master_access = str(record.get("master_access", "not documented"))
        semantic = self._write_semantics(master_access, fields, bool(record.get("write_side_effects")))
        address_text = str(record["address"])
        master_access_allowed = bool(record.get("ethercat_master_access_allowed", False))
        dangerous = self._dangerous(record, address_space, semantic)
        # Counter write-to-clear semantics are not read acknowledgements; DC
        # latching notes describe the documented full-width read transaction.
        address = self._start_address(address_text)
        counter = 0x0300 <= address < 0x0314 or address in (0x0442, 0x0443)
        read_effects = [text for text in record.get("read_side_effects", []) if not text.startswith("Multi-byte DC time reads")]
        read_access = " ".join([master_access, *(str(field.get("ecat_access", "")) for field in fields)])
        manual_read = bool(read_effects or "READ_SIDE_EFFECT" in read_access
                           or (not counter and "ACK_SEMANTIC" in read_access))
        reserved = str(record.get("name", "")).strip().lower().startswith("reserved") or bool(fields and all(field.get("reserved") for field in fields))
        # PDI Error Code is a named register even when a chip reserves all its fields.
        if address_space == "esc_core" and address == 0x030E:
            reserved = False
        memory = address_space in {"user_ram", "process_ram"}
        manual_read = manual_read or memory
        readable = address_space in {"esc_core", "user_ram", "process_ram"} and master_access_allowed and semantic != "WO"
        return {
            "definition_id": f"{profile}|{address_space}|{address_text}", "profile": profile,
            "source_chip": record["chip"], "register_family": self.get(profile).register_family.value,
            "address": self._start_address(address_text), "address_text": address_text,
            "address_space": address_space, "address_space_label": record.get("address_space"),
            "width": max(1, (int(record.get("width_bits") or 8) + 7) // 8), "width_bits": record.get("width_bits"),
            "name": record.get("name", "Unnamed register"), "official_name": record.get("official_name"),
            "aliases": record.get("alias", []), "group": record.get("category", "Other"),
            "access": semantic, "master_access": master_access, "master_access_allowed": master_access_allowed,
            "direct_read_allowed": readable,
            "direct_write_allowed": address_space == "esc_core" and master_access_allowed and not dangerous,
            "dangerous": dangerous,
            "requires_manual_read": manual_read, "is_reserved": reserved,
            "automatic_read_allowed": readable and not manual_read and not reserved and master_access != "not documented",
            "description": record.get("description_zh") or "; ".join(record.get("notes", [])) or str(record.get("official_name") or record.get("name")),
            "documentation_notes": record.get("notes", []),
            "reset_value": record.get("reset_value"), "power_on_default": record.get("power_on_default"),
            "access_granularity": record.get("access_granularity"), "pdi_access": record.get("pdi_access"),
            "pdi_hbi_access_allowed": record.get("pdi_hbi_access_allowed"), "state_restriction": record.get("state_restriction"),
            "hardware_condition": record.get("hardware_condition"), "read_side_effects": record.get("read_side_effects", []),
            "write_side_effects": record.get("write_side_effects", []), "write_sequence": record.get("write_sequence"),
            "byte_order": record.get("byte_order"), "reserved_bits_rule": record.get("reserved_bits_rule"),
            "fields": fields, "bit_fields": [self._compact_field(field) for field in fields],
            "field_variants": record.get("field_variants", []),
            "source": record.get("source", []), "confidence": record.get("confidence"), "record_kind": record.get("record_kind"),
        }

    def _catalog_key(self, chip_model: str, fmmu_count: int | None, sm_count: int | None) -> tuple[str, int, int]:
        """Bound channel definitions to the live capabilities or profile defaults."""
        profile = self.get(chip_model)
        return (profile.chip_model,
                min(32, max(0, fmmu_count if fmmu_count is not None else profile.fixed_fmmu_count or 8)),
                min(32, max(0, sm_count if sm_count is not None else profile.fixed_sm_count or 8)))

    def _channels(self, profile: str, fmmu_count: int, sm_count: int) -> list[dict[str, Any]]:
        """Expand the standard FMMU/SM layout without assuming vendor channel counts."""
        result = []
        for base, stride, count, prefix in ((0x0600, 16, fmmu_count, "FMMU"), (0x0800, 8, sm_count, "SyncManager")):
            source_chip = _FAMILY_SOURCE.get(profile, "ET1100")
            templates = [item for item in self._database["chips"][source_chip]
                         if item.get("record_kind") == "register" and base <= self._start_address(item["address"]) < base + stride]
            for channel in range(count):
                for template in templates:
                    record = copy.deepcopy(template)
                    width = (int(record["width_bits"]) + 7) // 8
                    address = self._start_address(record["address"]) + channel * stride
                    record["address"] = f"0x{address:04X}" + (f"-0x{address + width - 1:04X}" if width > 1 else "")
                    record["name"] = record["name"].replace(f"{prefix}0", f"{prefix}{channel}")
                    record["official_name"] = record["name"]
                    record["notes"] = [*template.get("notes", []), f"{prefix} 通道 {channel}；通道数量来自 ESC 能力寄存器。"]
                    definition = self._definition(profile, record)
                    # Expanded channels are diagnostic references, not new write paths.
                    definition.update(channel_kind=prefix, channel_index=channel, direct_write_allowed=False, dangerous=True)
                    result.append(definition)
        return result

    def catalog(self, chip_model: str, fmmu_count: int | None = None, sm_count: int | None = None) -> list[dict[str, Any]]:
        """Combine the selected profile with the implemented standard channel arrays."""
        profile = self.get(chip_model).chip_model
        key = self._catalog_key(profile, fmmu_count, sm_count)
        with self._catalog_lock:
            cached = self._catalog_cache.get(key)
            if cached is not None:
                return cached
            source_chip = _FAMILY_SOURCE.get(profile)
            if source_chip is None:
                catalog = self._generic_catalog()
            else:
                catalog = [
                    self._definition(profile, record)
                    for record in self._database["chips"][source_chip]
                    if record.get("record_kind") in {"register", "memory_region"}
                ]
            # Keep full memory ranges as documentation and expose bounded manual-read windows.
            regions = [item for item in catalog if item["record_kind"] == "memory_region"]
            catalog = [item for item in catalog if item["record_kind"] != "memory_region"]
            for region in regions:
                # Both RAM categories expose four-byte windows for explicit reads.
                window_size = 4
                for offset in range(0, region["width"], window_size):
                    item = copy.deepcopy(region)
                    item["address"] = region["address"] + offset
                    item["width"] = min(window_size, region["width"] - offset)
                    item["width_bits"] = item["width"] * 8
                    item["address_text"] = f"0x{item['address']:04X}-0x{item['address'] + item['width'] - 1:04X}"
                    item["definition_id"] = f"{profile}|{item['address_space']}|{item['address_text']}"
                    name = "RAM" if item["address_space"] == "process_ram" else region["name"]
                    item["name"] = f"{name} {item['address_text']}"
                    item["fields"] = []; item["bit_fields"] = []
                    catalog.append(item)
            # Preserve documented channel permissions and add only missing definitions.
            implemented = []
            for item in catalog:
                address = item["address"]
                if item["address_space"] == "esc_core" and 0x0600 <= address < 0x0900:
                    is_fmmu = address < 0x0800
                    base, stride, count = (0x0600, 16, key[1]) if is_fmmu else (0x0800, 8, key[2])
                    channel = (address - base) // stride
                    if channel >= count:
                        continue
                    item.update(channel_kind="FMMU" if is_fmmu else "SyncManager", channel_index=channel)
                implemented.append(item)
            existing = {(item["address_space"], item["address"]) for item in implemented}
            implemented.extend(item for item in self._channels(profile, key[1], key[2])
                               if (item["address_space"], item["address"]) not in existing)
            catalog = implemented
            catalog.sort(key=lambda item: (item["address_space"], item["address"]))
            self._catalog_cache[key] = catalog
            return catalog

    def catalog_version(self, chip_model: str, fmmu_count: int | None = None, sm_count: int | None = None) -> str:
        """Identify the profile and effective channel layout within this host session."""
        return ":".join(map(str, self._catalog_key(chip_model, fmmu_count, sm_count)))

    def catalog_summary(self, chip_model: str, fmmu_count: int | None = None, sm_count: int | None = None) -> list[dict[str, Any]]:
        """Return the list-view fields only; full bit-field data is fetched on selection.

        The investigation data contains long field descriptions and source records.
        Sending every detail for hundreds of registers through the Tauri IPC made
        the initial catalogue unnecessarily large and left the UI blank on some
        WebView instances.
        """
        keys = (
            "definition_id", "profile", "source_chip", "register_family", "address", "address_text", "address_space",
            "address_space_label", "width", "width_bits", "name", "group", "access", "master_access",
            "master_access_allowed", "direct_read_allowed", "direct_write_allowed", "dangerous",
            "description", "confidence", "record_kind", "aliases", "official_name",
            "requires_manual_read", "automatic_read_allowed", "is_reserved", "channel_kind", "channel_index",
        )
        profile = self.get(chip_model).chip_model
        key = self._catalog_key(profile, fmmu_count, sm_count)
        with self._catalog_lock:
            cached = self._summary_cache.get(key)
            if cached is None:
                cached = [{field: definition.get(field) for field in keys} for definition in self.catalog(profile, key[1], key[2])]
                self._summary_cache[key] = cached
            return cached

    def _generic_catalog(self) -> list[dict[str, Any]]:
        return [
            self._definition("Generic ESC", record)
            for record in self._database["chips"]["ET1100"]
            if record.get("record_kind") == "register" and record.get("address_space") == "ESC Core CSR"
            and self._start_address(str(record["address"])) < 0x0E00
        ]

    def definition(self, chip_model: str, definition_id: str, fmmu_count: int | None = None, sm_count: int | None = None) -> dict[str, Any]:
        profile = self.get(chip_model).chip_model
        definition = next((item for item in self.catalog(profile, fmmu_count, sm_count) if item["definition_id"] == definition_id), None)
        if definition is None:
            raise ValueError("Register definition is not in the selected slave profile")
        return definition

    def find(self, chip_model: str, address_space: str, address: int) -> dict[str, Any] | None:
        return next((item for item in self.catalog(chip_model) if item["address_space"] == address_space and item["address"] == address), None)

    def standard_registers(self, chip_model: str | None = None) -> list[dict[str, Any]]:
        """Compatibility entrypoint for the legacy small generic catalog.

        New UI/bridge callers use :meth:`catalog` with a selected profile.
        """
        if chip_model is None:
            resource = files("ethercat_debug_tool.esc_profiles.data").joinpath("standard_registers.json")
            return json.loads(resource.read_text(encoding="utf-8"))
        return self.catalog(chip_model)
