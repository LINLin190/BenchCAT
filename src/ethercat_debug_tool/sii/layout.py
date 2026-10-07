from __future__ import annotations

from .parser import SiiParser, SiiValidationError

CATEGORY_NAMES = {
    0x000A: "Strings", 0x001E: "General", 0x0028: "FMMU", 0x0029: "SyncManager",
    0x0032: "TxPDO", 0x0033: "RxPDO", 0x003C: "Distributed Clocks",
}


# Only expose fixed fields present in the snapshot and categories accepted by the SII parser.
def image_layout(raw: bytes) -> dict[str, object]:
    fields = [
        ("ConfigData", 0, 14), ("CRC / Reserved", 14, 2),
        ("Identity", 0x10, 16), ("Mailbox / Reserved", 0x20, 0x5C),
        ("EEPROM Size / Version", 0x7C, 4),
    ]
    sections: list[dict[str, object]] = [
        {"name": name, "kind": None, "offset": offset, "length": min(length, len(raw) - offset)}
        for name, offset, length in fields if offset < len(raw)
    ]
    try:
        parsed = SiiParser().parse(raw, require_full_capacity=False)
    except SiiValidationError as exc:
        return {"layout": sections, "layout_error": str(exc)}
    sections.extend(
        {"name": CATEGORY_NAMES.get(c.kind, "Vendor-specific" if c.kind >= 0x8000 else "Unknown"),
         "kind": c.kind, "offset": c.offset, "length": 4 + len(c.payload)}
        for c in parsed.categories
    )
    sections.append({"name": "End marker", "kind": 0xFFFF, "offset": parsed.end_offset, "length": 2})
    return {"layout": sections, "layout_error": None}
