"""Rebuild physical-page references from the bundled, versioned PDF manuals."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from pypdf import PdfReader

from ethercat_debug_tool.esc_profiles.profiles import ProfileRegistry

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src/ethercat_debug_tool/esc_profiles/data"
MANUALS = ROOT / "desktop/src-tauri/resources/manuals"
DOCUMENTS = [
    ("beckhoff_esc_register_en.pdf", "ET1100", "beckhoff_sec2_v3.3", "3.3"),
    ("beckhoff_et1100_datasheet_en.pdf", "ET1100", "beckhoff_et1100_v2.1", "2.1"),
    ("microchip_lan9252_register_zh.pdf", "LAN9252", "microchip_lan9252_ds00001909c", "DS00001909A_CN"),
    ("microchip_lan9252_register_en.pdf", "LAN9252", "microchip_lan9252_ds00001909c", "DS00001909C"),
    ("microchip_lan9253_register_en.pdf", "LAN9253", "microchip_lan9253_ds00003421b", "DS00003421B"),
]


# Walk nested outlines without discarding the vendor's page destinations.
def outline_items(items):
    for item in items:
        if isinstance(item, list):
            yield from outline_items(item)
        else:
            yield item


# Use each document's own bookmarks; Chinese pages never inherit English page numbers.
def build_index() -> dict:
    database = json.loads((DATA / "esc_register_database.json").read_text(encoding="utf-8"))
    result = {}
    for filename, chip, source_id, version in DOCUMENTS:
        path = MANUALS / filename
        reader = PdfReader(path)
        if version not in reader.pages[0].extract_text():
            raise ValueError(f"Unexpected document revision: {filename}, expected {version}")
        bookmarks = {}
        for item in outline_items(reader.outline):
            title = item.title.rstrip("\x00")
            match = re.match(r"^(\d+(?:\.\d+)*)\s", title)
            table = re.match(r"^(?:Table\s+|表)(\d+-\d+)(?:\s|：|:)", title)
            section = match[1] if match else f"Table {table[1]}" if table else None
            page = reader.get_destination_page_number(item)
            if section and page is not None:
                bookmarks[section] = page + 1
        sections = {}
        for record in database["chips"][chip]:
            for source in record.get("source", []):
                if source["source_id"] != source_id:
                    continue
                for section in source.get("section", "").split(" / "):
                    page = bookmarks.get(section)
                    # Only the matching English revision can use catalogue physical pages.
                    if page is None and not filename.endswith("_zh.pdf"):
                        page = source.get("pdf_page")
                        if page is None and filename.startswith("microchip_"):
                            page = source.get("page")
                    if isinstance(page, int) and 1 <= page <= len(reader.pages):
                        previous = sections.get(section)
                        if previous is not None and previous != page:
                            raise ValueError(f"Conflicting pages: {filename}, {section}")
                        sections[section] = page
        # Key each source register by its normalized space and original address range.
        registers = {}
        registry = ProfileRegistry()
        for record in database["chips"][chip]:
            definition = registry._definition(chip, record)
            candidates = [section for source in record.get("source", [])
                          if source["source_id"] == source_id
                          for section in source.get("section", "").split(" / ")]
            if filename == "beckhoff_et1100_datasheet_en.pdf":
                candidates = ["2.2"]
            section = next((item for item in candidates if item in sections), None)
            if section is not None:
                registers[f"{definition['address_space']}|{definition['address_text']}"] = {
                    "section": section, "pdf_page": sections[section],
                }
        result[filename] = {
            "source_id": source_id, "version": version,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "page_count": len(reader.pages), "sections": sections, "registers": registers,
        }
    return result


# Keep the index reproducible and packaged with the existing register data.
if __name__ == "__main__":
    (DATA / "register_manual_index.json").write_text(
        json.dumps(build_index(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
