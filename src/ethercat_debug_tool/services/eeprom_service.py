from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from ..backends.base import CommunicationError, EtherCatBackend
from ..esi.parser import EsiDevice
from ..models import EepromBackup, OperationProgress, SlaveInfo
from ..sii.parser import MAX_EEPROM_BYTES, SiiImage, SiiParser, inspect_sii_header, validate_eeprom_range
from .register_service import ResetService

ProgressCallback = Callable[[OperationProgress], None]
CancelCallback = Callable[[], bool]


class EepromOperationCancelled(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class EepromComparison:
    equal: bool
    differing_bytes: int
    first_difference: int | None
    target_sha256: str
    readback_sha256: str


@dataclass(frozen=True, slots=True)
class EepromFlashResult:
    bytes_read_back: int
    words_written: int
    comparison: EepromComparison
    sii_valid: bool
    semantic_valid: bool | None
    image_verification: str
    reset_sequence: tuple[bool, bool, bool] | None
    rediscovered: bool | None
    reload_verified: bool | None
    attempts: int = 1
    reload_error: str | None = None

    @property
    def image_success(self) -> bool:
        return self.comparison.equal


def compare_images(target: bytes, readback: bytes) -> EepromComparison:
    common = min(len(target), len(readback))
    differences = sum(a != b for a, b in zip(target[:common], readback[:common], strict=True))
    differences += abs(len(target) - len(readback))
    first = next((i for i, (a, b) in enumerate(zip(target, readback, strict=False)) if a != b), None)
    if first is None and len(target) != len(readback):
        first = common
    return EepromComparison(
        differences == 0,
        differences,
        first,
        hashlib.sha256(target).hexdigest(),
        hashlib.sha256(readback).hexdigest(),
    )


class EepromService:
    """Runs as a single exclusive Worker task; never call it from the GUI thread."""

    def __init__(
        self,
        backend: EtherCatBackend,
        *,
        rediscovery_timeout_s: float = 3.0,
        rediscovery_poll_s: float = 0.1,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.backend = backend
        self.rediscovery_timeout_s = max(0.0, rediscovery_timeout_s)
        self.rediscovery_poll_s = max(0.01, rediscovery_poll_s)
        self.sleep = sleep
        self.monotonic = monotonic
        self.parser = SiiParser()

    def _rediscover(self, position: int, device: EsiDevice | None) -> bool:
        deadline = self.monotonic() + self.rediscovery_timeout_s
        while True:
            try:
                if any(
                    item.position == position and (
                        device is None or (
                            item.identity_valid is not False
                            and (item.identity.vendor_id, item.identity.product_code, item.identity.revision)
                            == (device.vendor_id, device.product_code, device.revision)
                        )
                    )
                    for item in self.backend.scan()
                ):
                    return True
            except Exception:
                pass
            remaining = deadline - self.monotonic()
            if remaining <= 0:
                return False
            self.sleep(min(self.rediscovery_poll_s, remaining))

    @staticmethod
    def _check_cancel(cancel: CancelCallback) -> None:
        if cancel():
            raise EepromOperationCancelled("EEPROM operation was safely cancelled between EtherCAT requests")

    @staticmethod
    def capacity_from_size_word(size_word: int) -> int:
        capacity = (size_word + 1) * 128
        if not 128 <= capacity <= MAX_EEPROM_BYTES:
            raise ValueError("EEPROM 声明容量无效或超出 128 KiB，请指定读取长度")
        return capacity

    def read_capacity(self, position: int) -> int:
        header = inspect_sii_header(self._read_chunk(position, 0, 128))
        if header.capacity is None:
            raise ValueError(f"{header.error}；容量未知，请指定读取长度，或使用所选目标镜像的长度烧录")
        return header.capacity

    def read_configuration_header(self, position: int) -> bytes:
        """Read the eight-word ESC configuration area without scanning the full EEPROM."""
        return self._read_chunk(position, 0, 16)

    def _read_chunk(self, position: int, word_address: int, byte_count: int = 4) -> bytes:
        # The transport handles protocol timing; do not conceal read failures here.
        return self.backend.eeprom_read_block(position, word_address, byte_count).data

    def read_full(
        self,
        position: int,
        *,
        capacity: int | None = None,
        progress: ProgressCallback = lambda _: None,
        cancel: CancelCallback = lambda: False,
        progress_operation: str = "eeprom-read",
        progress_stage: str = "read",
        cancellable: bool = True,
    ) -> bytes:
        capacity = self.read_capacity(position) if capacity is None else capacity
        validate_eeprom_range(0, capacity)
        result = bytearray()
        for byte_offset in range(0, capacity, 128):
            self._check_cancel(cancel)
            byte_count = min(128, capacity - byte_offset)
            chunk = self._read_chunk(position, byte_offset // 2, byte_count)
            if len(chunk) != byte_count:
                raise CommunicationError(f"EEPROM returned {len(chunk)} bytes; expected {byte_count}")
            result.extend(chunk)
            progress(
                OperationProgress(
                    progress_operation,
                    progress_stage,
                    byte_offset + byte_count,
                    capacity,
                    f"0x{byte_offset:04X}",
                    cancellable,
                )
            )
        return bytes(result[:capacity])

    # Export raw EEPROM bytes using the slave's displayed name.
    def backup(
        self,
        position: int,
        directory: Path,
        slave: SlaveInfo,
        *,
        progress: ProgressCallback = lambda _: None,
        cancel: CancelCallback = lambda: False,
        capacity: int | None = None,
    ) -> EepromBackup:
        raw = self.read_full(
            position,
            capacity=capacity,
            progress=progress,
            cancel=cancel,
            progress_operation="eeprom-backup",
            progress_stage="backup-read",
        )
        sha256 = hashlib.sha256(raw).hexdigest()
        directory.mkdir(parents=True, exist_ok=True)
        device_name = slave.product_model or slave.name or "Unknown"
        device_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", device_name).strip() or "Unknown"
        stem = f"Slave {position} ({device_name})"
        binary_path = directory / f"{stem}.bin"
        # Reserve each filename exclusively; existing exports keep their bytes.
        suffix = 1
        while True:
            try:
                output = binary_path.open("xb")
                break
            except FileExistsError:
                suffix += 1
                binary_path = directory / f"{stem} ({suffix}).bin"
        with output:
            output.write(raw)
        return EepromBackup(binary_path, sha256, len(raw))

    @staticmethod
    def semantic_matches(image: SiiImage, device: EsiDevice) -> bool:
        if (image.vendor_id, image.product_code, image.revision, image.serial_number) != (
            device.vendor_id,
            device.product_code,
            device.revision,
            device.serial_number,
        ):
            return False
        if not device.name and not device.type_name:
            return True
        kinds = {category.kind for category in image.categories}
        expected_names = {device.name, device.type_name}
        return {0x000A, 0x001E} <= kinds and all(
            not name or name in image.strings for name in expected_names
        )

    def flash(
        self,
        position: int,
        target: bytes,
        device: EsiDevice | None = None,
        *,
        auto_reset: bool = False,
        progress: ProgressCallback = lambda _: None,
        cancel: CancelCallback = lambda: False,
    ) -> EepromFlashResult:
        """Write the complete target without depending on the old SII or its size."""
        if not target:
            raise ValueError("烧录文件不能为空")
        aligned_size = len(target) + len(target) % 2
        validate_eeprom_range(0, aligned_size)
        self._check_cancel(cancel)
        tail = b""
        if len(target) % 2:
            # Preserve the byte outside an odd-sized BIN instead of padding the file.
            last_word = self._read_chunk(position, len(target) // 2, 2)
            if len(last_word) != 2:
                raise CommunicationError("烧录失败：末尾 Word 读取不完整")
            tail = last_word[1:]
        self._check_cancel(cancel)
        words_written = 0
        word_count = aligned_size // 2
        progress(OperationProgress(
            "eeprom-flash", "write-verify", 0, word_count,
            f"写入全部 {word_count} Word", cancellable=False,
        ))
        for word in range(word_count):
            data = target[word * 2:word * 2 + 2]
            if len(data) == 1:
                data += tail
            try:
                self.backend.eeprom_write(position, word, data)
            except Exception as exc:
                raise CommunicationError(
                    f"烧录失败：word 0x{word:04X}（字节地址 0x{word * 2:04X}）写入失败；"
                    f"已写入 {words_written} Word：{exc}"
                ) from exc
            words_written += 1
            progress(OperationProgress(
                "eeprom-flash", "write-verify", words_written, word_count,
                f"word 0x{word:04X}", cancellable=False,
            ))
        # Completed controller commands already include the required Busy wait.
        try:
            readback = self.read_full(
                position, capacity=aligned_size, progress=progress, cancel=lambda: False,
                progress_operation="eeprom-flash", progress_stage="full-verify", cancellable=False,
            )[:len(target)]
        except Exception as exc:
            raise CommunicationError(f"烧录失败：完整回读失败：{exc}") from exc
        comparison = compare_images(target, readback)
        try:
            parsed = self.parser.parse(readback)
        except ValueError:
            parsed = None
        sii_valid = parsed is not None
        semantic_valid = (
            parsed is not None and self.semantic_matches(parsed, device)
            if device is not None else None
        )
        verification = "烧录完成，完整回读与目标一致"
        if not comparison.equal and comparison.first_difference is not None:
            offset = comparison.first_difference
            verification = (
                f"烧录失败：字节地址 0x{offset:04X}（word 0x{offset // 2:04X}）不一致；"
                f"expected={target[offset]:02X} actual={readback[offset]:02X}"
            )
        reset: tuple[bool, bool, bool] | None = None
        rediscovered: bool | None = None
        reload_verified: bool | None = None
        reload_error: str | None = None
        if comparison.equal and auto_reset:
            # Reset is opt-in and its outcome never changes the programming result.
            progress(OperationProgress(
                "eeprom-flash", "reset", 0, 1, "发送 ESC 复位序列", cancellable=False,
            ))
            try:
                reset = ResetService(self.backend).reset_ecat(position)
            except Exception as exc:
                reset = (False, False, False)
                reload_error = f"镜像已写入，ESC 复位命令失败：{exc}"
            rediscovered = self._rediscover(position, device)
            progress(OperationProgress(
                "eeprom-flash", "reset", 1, 1,
                "已重新发现从站" if rediscovered else "复位后未重新发现从站",
                cancellable=False,
            ))
            if rediscovered:
                try:
                    reload = self.read_full(
                        position, capacity=aligned_size, progress=progress, cancel=lambda: False,
                        progress_operation="eeprom-flash", progress_stage="reload-verify",
                        cancellable=False,
                    )[:len(target)]
                    reload_verified = all(reset) and compare_images(target, reload).equal
                    if not reload_verified and reload_error is None:
                        reload_error = "镜像写入后回读一致，但复位序列未完成或复位后的回读已变化"
                except Exception as exc:
                    reload_verified = False
                    reload_error = f"复位后回读失败：{exc}"
            else:
                reload_verified = False
                reload_error = "镜像已写入，复位后未发现目标设备；部分配置需要断电重启才能生效"
        return EepromFlashResult(
            len(readback), words_written, comparison, sii_valid, semantic_valid,
            verification, reset, rediscovered, reload_verified, reload_error=reload_error,
        )

    def restore(self, position: int, backup_path: Path, **kwargs: object) -> EepromFlashResult:
        """Program raw BIN bytes without requiring a valid SII header or categories."""
        raw = backup_path.read_bytes()
        return self.flash(position, raw, **kwargs)  # type: ignore[arg-type]
