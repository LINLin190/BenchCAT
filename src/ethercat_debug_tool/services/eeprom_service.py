from __future__ import annotations

import hashlib
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
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
    semantic_valid: bool
    image_verification: str
    reset_sequence: tuple[bool, bool, bool] | None
    rediscovered: bool | None
    reload_verified: bool | None
    attempts: int = 1
    reload_error: str | None = None

    @property
    def image_success(self) -> bool:
        return self.comparison.equal and self.sii_valid and self.semantic_valid


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
        stability_wait_s: float = 0.5,
        rediscovery_timeout_s: float = 3.0,
        rediscovery_poll_s: float = 0.1,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.backend = backend
        self.stability_wait_s = stability_wait_s
        self.rediscovery_timeout_s = max(0.0, rediscovery_timeout_s)
        self.rediscovery_poll_s = max(0.01, rediscovery_poll_s)
        self.sleep = sleep
        self.monotonic = monotonic
        self.parser = SiiParser()

    def _rediscover(self, position: int, device: EsiDevice) -> bool:
        deadline = self.monotonic() + self.rediscovery_timeout_s
        while True:
            try:
                if any(
                    item.position == position and item.identity_valid is not False
                    and (item.identity.vendor_id, item.identity.product_code, item.identity.revision)
                    == (device.vendor_id, device.product_code, device.revision)
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
        for attempt in range(3):
            try:
                return self.backend.eeprom_read_block(position, word_address, byte_count).data
            except CommunicationError:
                if attempt == 2:
                    raise
                self.sleep(0.02)
        raise AssertionError("unreachable")

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
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        binary_path = directory / f"slave{position}_{slave.identity.product_code:08X}_{stamp}_{uuid.uuid4().hex[:8]}.bin"
        with binary_path.open("xb") as output:
            output.write(raw)
        return EepromBackup(binary_path, sha256, len(raw))

    @staticmethod
    def different_words(current: bytes, target: bytes) -> tuple[int, ...]:
        if len(current) != len(target) or len(target) % 2:
            raise ValueError("EEPROM images must have the same even size")
        return tuple(
            offset // 2
            for offset in range(0, len(target), 2)
            if current[offset : offset + 2] != target[offset : offset + 2]
        )

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
        device: EsiDevice,
        *,
        auto_reset: bool = True,
        progress: ProgressCallback = lambda _: None,
        cancel: CancelCallback = lambda: False,
    ) -> EepromFlashResult:
        validate_eeprom_range(0, len(target))
        if not self.semantic_matches(self.parser.parse(target), device):
            raise ValueError("烧录失败：目标镜像与所选 XML Device 不一致")
        current: bytes | None = None
        last_error = ""
        try:
            current = self.read_full(
                position, capacity=len(target), progress=progress, cancel=cancel,
                progress_operation="eeprom-flash", progress_stage="read-current",
            )
        except CommunicationError as exc:
            # Bad existing contents do not impose a dependency on a usable SII.
            # If the controller accepts writes, the final full read decides success.
            last_error = str(exc)
        self._check_cancel(cancel)
        written: set[int] = set()
        write_attempted = False
        readback: bytes | None = current
        attempts = 0
        for attempts in range(1, 4):
            words = self.different_words(current, target) if current is not None else tuple(range(len(target) // 2))
            if not words:
                readback = current
                progress(OperationProgress(
                    "eeprom-flash", "write-verify", 1, 1,
                    "完整回读已与目标一致，无需重复写入", cancellable=False,
                ))
                break
            progress(OperationProgress(
                "eeprom-flash", "write-verify", 0, len(words),
                f"第 {attempts}/3 轮写入，共 {len(words)} Word", cancellable=False,
            ))
            for completed, word in enumerate(words, 1):
                try:
                    write_attempted = True
                    self.backend.eeprom_write(position, word, target[word * 2:word * 2 + 2])
                    written.add(word)
                except Exception as exc:
                    last_error = f"word 0x{word:04X}：{exc}"
                    break
                progress(OperationProgress(
                    "eeprom-flash", "write-verify", completed, len(words),
                    f"第 {attempts}/3 轮，word 0x{word:04X}", cancellable=False,
                ))
            progress(OperationProgress(
                "eeprom-flash", "stability-wait", 0, 1, "等待 EEPROM 写入结束", cancellable=False,
            ))
            self.sleep(self.stability_wait_s)
            try:
                readback = self.read_full(
                    position, capacity=len(target), progress=progress, cancel=lambda: False,
                    progress_operation="eeprom-flash", progress_stage="full-verify", cancellable=False,
                )
            except Exception as exc:
                readback = current = None
                last_error = f"完整回读失败：{exc}"
                continue
            comparison = compare_images(target, readback)
            if comparison.equal:
                break
            current = readback
        if readback is None:
            raise CommunicationError(f"烧录失败：已尝试 {attempts} 轮；{last_error}")
        comparison = compare_images(target, readback)
        try:
            readback_parsed = self.parser.parse(readback)
        except ValueError:
            readback_parsed = None
        sii_valid = readback_parsed is not None
        semantic_valid = readback_parsed is not None and self.semantic_matches(readback_parsed, device)
        verification = (
            "烧录完成，完整回读与目标一致"
            if (comparison.equal and semantic_valid)
            else "烧录失败：完整回读与目标不一致或 SII 内容无效"
        )
        if not comparison.equal and comparison.first_difference is not None:
            word = comparison.first_difference // 2
            expected = target[word * 2 : word * 2 + 2]
            actual = readback[word * 2 : word * 2 + 2]
            verification = (
                f"烧录失败：{attempts} 轮后 word 0x{word:04X} 不一致；"
                f"expected={expected.hex().upper()} actual={actual.hex().upper()} "
                f"{last_error}"
            )
        reset: tuple[bool, bool, bool] | None = None
        rediscovered: bool | None = None
        reload_verified: bool | None = None
        reload_error: str | None = None
        if comparison.equal and semantic_valid and auto_reset and write_attempted:
            # The three calls below are adjacent inside this exclusive Worker operation.
            progress(
                OperationProgress(
                    "eeprom-flash", "reset", 0, 1, "发送 ESC 复位序列", cancellable=False
                )
            )
            try:
                reset = ResetService(self.backend).reset_ecat(position)
            except Exception as exc:
                reset = (False, False, False)
                reload_error = f"镜像已写入，ESC 复位命令失败：{exc}"
            # A temporary drop after reset is expected and never rewrites the image result.
            rediscovered = self._rediscover(position, device)
            progress(
                OperationProgress(
                    "eeprom-flash",
                    "reset",
                    1,
                    1,
                    "已重新发现从站" if rediscovered else "复位后未重新发现从站",
                    cancellable=False,
                )
            )
            if rediscovered:
                try:
                    reload = self.read_full(
                        position,
                        capacity=len(target),
                        progress=progress,
                        cancel=lambda: False,
                        progress_operation="eeprom-flash",
                        progress_stage="reload-verify",
                        cancellable=False,
                    )
                    reload_image = self.parser.parse(reload)
                    reload_verified = all(reset) and compare_images(target, reload).equal and self.semantic_matches(
                        reload_image, device
                    )
                    if not reload_verified and reload_error is None:
                        reload_error = "镜像烧录后回读一致，但复位序列未完成或复位后的回读已变化"
                except Exception as exc:
                    reload_verified = False
                    reload_error = f"复位后回读失败：{exc}"
            else:
                reload_verified = False
                reload_error = "镜像已写入，复位后未发现目标设备；部分配置需要断电重启才能生效"
        return EepromFlashResult(
            len(readback),
            len(written),
            comparison,
            sii_valid,
            semantic_valid,
            verification,
            reset,
            rediscovered,
            reload_verified,
            attempts,
            reload_error,
        )

    def restore(self, position: int, backup_path: Path, **kwargs: object) -> EepromFlashResult:
        validate_eeprom_range(0, backup_path.stat().st_size)
        raw = backup_path.read_bytes()
        parsed = self.parser.parse(raw)
        # Semantic target uses the selected BIN identity.
        synthetic = EsiDevice(
            0,
            "",
            "",
            "",
            parsed.vendor_id,
            parsed.product_code,
            parsed.revision,
            parsed.serial_number,
            len(raw),
            b"",
            b"",
            (),
            (),
            (),
            (),
            (),
            None,
            None,
            None,
            "",
            0,
            0,
            0,
        )
        return self.flash(position, raw, synthetic, **kwargs)  # type: ignore[arg-type]
