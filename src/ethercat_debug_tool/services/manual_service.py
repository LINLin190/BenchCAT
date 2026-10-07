from __future__ import annotations

import json
import os
from functools import lru_cache
from importlib.resources import files
from pathlib import Path
from typing import Any

MANUAL_TITLES = {
    "microchip_lan9252_register_zh.pdf": "LAN9252 官方中文手册（DS00001909A_CN）",
    "microchip_lan9252_register_en.pdf": "LAN9252 官方英文手册（DS00001909C）",
    "microchip_lan9253_register_en.pdf": "LAN9253 官方英文手册（DS00003421B）",
    "beckhoff_esc_register_en.pdf": "Beckhoff ESC 寄存器说明（英文，3.3）",
    "beckhoff_et1100_datasheet_en.pdf": "ET1100 器件手册（英文，2.1，寄存器概览）",
}


# Load physical-page metadata without parsing or rewriting vendor PDFs at runtime.
@lru_cache(maxsize=1)
def manual_index() -> dict[str, Any]:
    resource = files("ethercat_debug_tool.esc_profiles.data").joinpath("register_manual_index.json")
    return json.loads(resource.read_text(encoding="utf-8"))


# Scope addresses to a document revision and address space; templates retain source sections.
def manual_references(definition: dict[str, Any]) -> list[dict[str, Any]]:
    chip = definition.get("source_chip")
    names = (
        ["microchip_lan9252_register_zh.pdf", "microchip_lan9252_register_en.pdf"] if chip == "LAN9252"
        else ["microchip_lan9253_register_en.pdf"] if chip == "LAN9253"
        else ["beckhoff_esc_register_en.pdf", "beckhoff_et1100_datasheet_en.pdf"]
    )
    result = []
    for filename in names:
        document = manual_index()[filename]
        key = f"{definition.get('address_space')}|{definition.get('address_text')}"
        location = document["registers"].get(key)
        if location is None:
            # Expanded channels and RAM windows inherit only their own documented sections.
            sections = [section for source in definition.get("source", [])
                        if source["source_id"] == document["source_id"]
                        for section in source.get("section", "").split(" / ")]
            section = next((item for item in sections if item in document["sections"]), None)
            location = {"section": section, "pdf_page": document["sections"].get(section)}
        result.append({
            "filename": filename, "title": MANUAL_TITLES[filename], **location,
            "version": document["version"], "sha256": document["sha256"],
            "page_count": document["page_count"],
        })
    return result


# Resolve bundled resources without accepting a caller-supplied filesystem path.
def default_manual_root() -> Path:
    configured = os.environ.get("BENCHCAT_MANUALS_DIR")
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parents[3] / "desktop/src-tauri/resources/manuals"


# Serve original bytes from a fixed allowlist, independently of EtherCAT operations.
def read_manual(filename: str, manual_root: Path | None = None) -> bytes:
    if filename not in MANUAL_TITLES:
        raise ValueError("未知的寄存器手册")
    path = (manual_root or default_manual_root()) / filename
    if not path.is_file():
        raise FileNotFoundError(f"缺少离线手册：{filename}，请重新安装完整应用")
    return path.read_bytes()
