from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import replace
from pathlib import Path
from xml.parsers import expat

from .parser import EsiDocument, EsiParser


class EsiConfigSaveError(ValueError):
    """A source edit failed without changing the selected XML."""


# Find the selected Device's value by XML structure and original byte offsets.
def _config_span(raw: bytes, ordinal: int) -> tuple[int, int, str]:
    parser = expat.ParserCreate(namespace_separator="}")
    path: list[str] = []
    descriptions: tuple[str, ...] | None = None
    devices: tuple[str, ...] | None = None
    device_path: tuple[str, ...] | None = None
    config_path: tuple[str, ...] | None = None
    current = -1
    start: int | None = None
    end: int | None = None
    declared_encoding = "utf-8"

    # Follow the same first Descriptions/Devices ordering as EsiParser.
    def on_start(name: str, _attributes: dict[str, str]) -> None:
        nonlocal descriptions, devices, device_path, config_path, current, start
        local = name.rsplit("}", 1)[-1]
        path.append(local)
        position = tuple(path)
        if local == "Descriptions" and descriptions is None:
            descriptions = position
        elif local == "Devices" and position[:-1] == descriptions and devices is None:
            devices = position
        elif local == "Device" and position[:-1] == devices:
            current += 1
            if current == ordinal:
                device_path = position
        elif local == "ConfigData" and current == ordinal and device_path is not None and position[:-2] == device_path and path[-2] == "Eeprom" and start is None:
            config_path = position
            start = parser.CurrentByteIndex

    # Expat points to the closing tag, excluding all unrelated surrounding XML.
    def on_end(_name: str) -> None:
        nonlocal end
        if tuple(path) == config_path and end is None:
            end = parser.CurrentByteIndex
        path.pop()

    # Retain the source declaration when encoding the replacement bytes.
    def on_declaration(_version: str, encoding: str | None, _standalone: int) -> None:
        nonlocal declared_encoding
        declared_encoding = encoding or "utf-8"

    parser.StartElementHandler = on_start
    parser.EndElementHandler = on_end
    parser.XmlDeclHandler = on_declaration
    parser.Parse(raw, True)
    if start is None or end is None:
        raise EsiConfigSaveError("所选 Device 没有可编辑的 ConfigData，请重新加载 XML。")
    # Explicit endianness keeps UTF-16 files and their BOM untouched.
    encoding = "utf-16-le" if raw.startswith((b"\xff\xfe", b"<\x00")) else "utf-16-be" if raw.startswith((b"\xfe\xff", b"\x00<")) else declared_encoding
    segment = raw[start:end].decode(encoding)
    opening = re.match(r'''<(?:[^>"']|"[^"]*"|'[^']*')*>''', segment)
    if opening is None:
        raise EsiConfigSaveError("无法定位 ConfigData 内容，请重新加载 XML。")
    return start + len(opening.group().encode(encoding)), end, encoding


# Atomically replace one ConfigData value, retaining source encoding and formatting.
def save_config_data(document: EsiDocument, ordinal: int, value: str) -> EsiDocument:
    if not 0 <= ordinal < len(document.devices):
        raise EsiConfigSaveError("请先选择有效的 XML Device。")
    try:
        config = bytes.fromhex(value)
    except ValueError as exc:
        raise EsiConfigSaveError("ConfigData 必须是十六进制字节。") from exc
    if not 1 <= len(config) <= 14:
        raise EsiConfigSaveError("ConfigData 必须包含 1 到 14 个字节。")
    temporary: Path | None = None
    try:
        raw = document.path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != document.sha256:
            raise EsiConfigSaveError("XML 文件已被其他操作修改，请重新加载后再保存。")
        start, end, encoding = _config_span(raw, ordinal)
        text = raw[start:end].decode(encoding)
        leading = text[:len(text) - len(text.lstrip())]
        trailing = text[len(text.rstrip()):]
        body = text.strip()
        replacement = config.hex().upper()
        if body.startswith("<![CDATA[") and body.endswith("]]>"):
            replacement = f"<![CDATA[{replacement}]]>"
        elif "<" in body:
            raise EsiConfigSaveError("ConfigData 包含额外 XML 标记，无法直接编辑。")
        updated = raw[:start] + (leading + replacement + trailing).encode(encoding) + raw[end:]
        # Parse the complete candidate before replacing the original file.
        with tempfile.NamedTemporaryFile(dir=document.path.parent, prefix=f".{document.path.name}.", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        parsed = EsiParser().parse(temporary)
        if document.path.read_bytes() != raw:
            raise EsiConfigSaveError("XML 文件已被其他操作修改，请重新加载后再保存。")
        os.replace(temporary, document.path)
        temporary = None
        return replace(parsed, path=document.path)
    except OSError as exc:
        raise EsiConfigSaveError("无法保存 XML，请检查文件是否存在、是否只读以及写入权限。") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
