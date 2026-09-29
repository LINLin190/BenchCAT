from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

MAX_EEPROM_BYTES = 128 * 1024


def validate_eeprom_range(word_address: int, byte_count: int) -> None:
    if word_address < 0 or byte_count <= 0 or byte_count % 2:
        raise ValueError("EEPROM 地址和长度必须是有效的整 Word 范围")
    if word_address * 2 + byte_count > MAX_EEPROM_BYTES:
        raise ValueError("EEPROM 操作超出当前支持的 128 KiB 地址范围")


class SiiValidationError(ValueError):
    pass


def crc8(data: bytes) -> int:
    crc = 0xFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


@dataclass(frozen=True, slots=True)
class SiiHeader:
    status: str
    error: str | None
    capacity: int | None
    identity_valid: bool


def inspect_sii_header(data: bytes) -> SiiHeader:
    """Classify readable bytes without treating their contents as physical capacity."""
    if len(data) < 128:
        return SiiHeader("invalid", "SII 固定区不足 128 字节", None, False)
    if data[:16] in (bytes(16), b"\xff" * 16):
        return SiiHeader("blank", "EEPROM 配置区空白，疑似未烧录", None, False)
    errors: list[str] = []
    if crc8(data[:16]) != 0:
        errors.append("配置区 CRC-8 错误")
    size_word, version = struct.unpack_from("<HH", data, 0x7C)
    declared = (size_word + 1) * 128
    if version in (0, 0xFFFF):
        errors.append("SII 版本字段无效")
    if declared > MAX_EEPROM_BYTES:
        errors.append("SII 声明容量超出 128 KiB，不能作为读取长度")
    vendor, product, revision, _ = struct.unpack_from("<IIII", data, 0x10)
    identity_valid = vendor not in (0, 0xFFFFFFFF) and product != 0xFFFFFFFF and revision != 0xFFFFFFFF
    if not identity_valid:
        errors.append("SII 设备身份无效")
    return SiiHeader(
        "invalid" if errors else "header_valid", "；".join(errors) or None,
        declared if not errors else None, identity_valid and not errors,
    )


@dataclass(frozen=True, slots=True)
class SiiCategory:
    kind: int
    offset: int
    payload: bytes


@dataclass(frozen=True, slots=True)
class SiiImage:
    raw: bytes
    capacity: int
    vendor_id: int
    product_code: int
    revision: int
    serial_number: int
    size_word: int
    version: int
    categories: tuple[SiiCategory, ...]
    strings: tuple[str, ...]
    sha256: str
    end_offset: int


class SiiParser:
    CATEGORY_START = 0x80

    def parse(self, raw: bytes, *, require_full_capacity: bool = True) -> SiiImage:
        data = bytes(raw)
        if len(data) < self.CATEGORY_START or len(data) % 2:
            raise SiiValidationError("SII image must be an even-sized image of at least 128 bytes")
        if crc8(data[:16]) != 0:
            raise SiiValidationError("SII configuration header CRC-8 is invalid")
        vendor_id, product, revision, serial = struct.unpack_from("<IIII", data, 0x10)
        size_word, version = struct.unpack_from("<HH", data, 0x7C)
        capacity = (size_word + 1) * 128
        if capacity < self.CATEGORY_START or capacity % 128:
            raise SiiValidationError("SII EEPROM size field is invalid")
        if require_full_capacity and len(data) != capacity:
            raise SiiValidationError(
                f"SII image length {len(data)} does not match declared capacity {capacity}"
            )
        if len(data) > capacity:
            raise SiiValidationError("SII image exceeds its declared EEPROM capacity")
        if version in {0, 0xFFFF}:
            raise SiiValidationError("SII version is missing or invalid")

        categories: list[SiiCategory] = []
        end_offset: int | None = None
        offset = self.CATEGORY_START
        limit = min(len(data), capacity)
        while offset + 2 <= limit:
            kind = struct.unpack_from("<H", data, offset)[0]
            if kind == 0xFFFF:
                end_offset = offset
                break
            if offset + 4 > limit:
                raise SiiValidationError("Truncated SII category header")
            words = struct.unpack_from("<H", data, offset + 2)[0]
            payload_end = offset + 4 + words * 2
            if payload_end > limit:
                raise SiiValidationError(f"SII category 0x{kind:04X} exceeds image bounds")
            categories.append(SiiCategory(kind, offset, data[offset + 4 : payload_end]))
            offset = payload_end
        if end_offset is None:
            raise SiiValidationError("SII category end marker 0xFFFF is missing")
        strings = self._parse_strings(next((c.payload for c in categories if c.kind == 0x000A), b""))
        return SiiImage(
            data,
            capacity,
            vendor_id,
            product,
            revision,
            serial,
            size_word,
            version,
            tuple(categories),
            strings,
            hashlib.sha256(data).hexdigest(),
            end_offset,
        )

    @staticmethod
    def _parse_strings(payload: bytes) -> tuple[str, ...]:
        if not payload:
            return ()
        count, offset = payload[0], 1
        result: list[str] = []
        for _ in range(count):
            if offset >= len(payload):
                raise SiiValidationError("Truncated SII strings category")
            length = payload[offset]
            offset += 1
            if offset + length > len(payload):
                raise SiiValidationError("SII string exceeds strings category")
            result.append(payload[offset : offset + length].decode("latin-1", errors="replace"))
            offset += length
        return tuple(result)
