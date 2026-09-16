from __future__ import annotations

import hashlib
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from ..backends.base import CommunicationError, EtherCatBackend
from ..esi.parser import EsiDevice
from ..models import EepromBackup, OperationProgress, SlaveInfo
from ..sii.parser import SiiImage, SiiParser
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
        stability_wait_s: float = 1.0,
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

    def _rediscover(self, position: int) -> bool:
        deadline = self.monotonic() + self.rediscovery_timeout_s
        while True:
            try:
                if any(item.position == position for item in self.backend.scan()):
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
        if not 128 <= capacity <= 16 * 1024 * 1024:
            raise ValueError(f"EEPROM capacity field is unreasonable: {capacity} bytes")
        return capacity

    def read_capacity(self, position: int) -> int:
        size_and_version = self._read_chunk(position, 0x3E)
        if len(size_and_version) < 2:
            raise RuntimeError("EEPROM size word could not be read")
        return self.capacity_from_size_word(int.from_bytes(size_and_version[:2], "little"))

    def read_configuration_header(self, position: int) -> bytes:
        """Read the eight-word ESC configuration area without scanning the full EEPROM."""
        result = bytearray()
        for word_address in range(0, 8, 2):
            chunk = self._read_chunk(position, word_address)
            if len(chunk) != 4:
                raise RuntimeError(f"EEPROM returned {len(chunk)} bytes; expected four")
            result.extend(chunk)
        return bytes(result)

    def _read_chunk(self, position: int, word_address: int) -> bytes:
        for attempt in range(3):
            try:
                return self.backend.eeprom_read(position, word_address)
            except CommunicationError:
                if attempt == 2:
                    raise
                self.sleep(0.02)
        raise AssertionError("unreachable")

    def read_full(
        self,
        position: int,
        *,
        progress: ProgressCallback = lambda _: None,
        cancel: CancelCallback = lambda: False,
        progress_operation: str = "eeprom-read",
        progress_stage: str = "read",
        cancellable: bool = True,
    ) -> bytes:
        capacity = self.read_capacity(position)
        result = bytearray()
        for byte_offset in range(0, capacity, 4):
            self._check_cancel(cancel)
            chunk = self._read_chunk(position, byte_offset // 2)
            if len(chunk) != 4:
                raise RuntimeError(f"EEPROM returned {len(chunk)} bytes; expected four")
            result.extend(chunk)
            progress(
                OperationProgress(
                    progress_operation,
                    progress_stage,
                    min(byte_offset + 4, capacity),
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
    ) -> EepromBackup:
        raw = self.read_full(
            position,
            progress=progress,
            cancel=cancel,
            progress_operation="eeprom-backup",
            progress_stage="backup-read",
        )
        sha256 = hashlib.sha256(raw).hexdigest()
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        base = directory / f"slave{position}_{slave.identity.product_code:08X}_{stamp}"
        binary_path = base.with_suffix(".bin")
        binary_path.write_bytes(raw)
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
        self.parser.parse(target)
        if len(target) != self.read_capacity(position):
            raise ValueError("Target image size does not match the physical EEPROM capacity")
        # Read the complete current image to calculate changed words. This is not
        # persisted; users can create a BIN explicitly with the separate backup action.
        current = self.read_full(
            position,
            progress=progress,
            cancel=cancel,
            progress_operation="eeprom-flash",
            progress_stage="read-current",
        )
        words = self.different_words(current, target)
        total = len(words)
        # Cancellation is safe until programming starts. Once the first word is
        # written, finish programming and verification so the ESC is not left
        # with an arbitrarily partial SII image.
        self._check_cancel(cancel)
        if total == 0:
            progress(
                OperationProgress(
                    "eeprom-flash", "write-verify", 1, 1, "无需写入差异 Word", cancellable=False
                )
            )
        else:
            progress(
                OperationProgress(
                    "eeprom-flash",
                    "write-verify",
                    0,
                    total,
                    "已进入不可中断的写入与校验阶段",
                    cancellable=False,
                )
            )
        word_retry_counts: dict[int, int] = {}
        for completed, word in enumerate(words, 1):
            expected = target[word * 2 : word * 2 + 2]
            self.backend.eeprom_write(position, word, expected)
            for retry in range(4):
                try:
                    readback_word = self.backend.eeprom_read_checked(position, word)
                except CommunicationError:
                    pass  # The final full-image read decides whether programming succeeded.
                else:
                    if readback_word.data[:2] == expected:
                        break
                if retry < 3:
                    self.sleep(0.02)
            if retry:
                word_retry_counts[word] = retry
            progress(
                OperationProgress(
                    "eeprom-flash",
                    "write-verify",
                    completed,
                    total,
                    f"word 0x{word:04X}",
                    cancellable=False,
                )
            )

        # This wait is intentionally not cancellable: it is a mandatory stability stage.
        progress(
            OperationProgress(
                "eeprom-flash",
                "stability-wait",
                0,
                1,
                f"mandatory {self.stability_wait_s:g} second wait",
                cancellable=False,
            )
        )
        self.sleep(self.stability_wait_s)
        progress(
            OperationProgress(
                "eeprom-flash", "stability-wait", 1, 1, "EEPROM 已稳定", cancellable=False
            )
        )
        for attempt in range(3):
            if attempt:
                self.sleep(0.02)
            readback = self.read_full(
                position,
                progress=progress,
                cancel=lambda: False,
                progress_operation="eeprom-flash",
                progress_stage="full-verify",
                cancellable=False,
            )
            comparison = compare_images(target, readback)
            if comparison.equal:
                break
        try:
            readback_parsed = self.parser.parse(readback)
        except ValueError:
            readback_parsed = None
        sii_valid = readback_parsed is not None
        semantic_valid = readback_parsed is not None and self.semantic_matches(readback_parsed, device)
        verification = (
            "逐字节、SHA-256、SII 结构与 XML 身份语义均通过"
            if (comparison.equal and semantic_valid)
            else "镜像验证失败"
        )
        if not comparison.equal and comparison.first_difference is not None:
            word = comparison.first_difference // 2
            expected = target[word * 2 : word * 2 + 2]
            actual = readback[word * 2 : word * 2 + 2]
            try:
                diagnostic = self.backend.eeprom_read_checked(position, word)
                wkc = str(diagnostic.wkc)
                status = f"0x{diagnostic.status:04X}"
            except Exception:
                wkc, status = "unavailable", "unavailable"
            verification = (
                f"EEPROM full verification failed at word 0x{word:04X}: "
                f"expected={expected.hex().upper()} actual={actual.hex().upper()} "
                f"WKC={wkc} word_retries={word_retry_counts.get(word, 0)} "
                f"full_retries=2 0x0502={status}; "
                f"target_sha256={comparison.target_sha256} "
                f"readback_sha256={comparison.readback_sha256}"
            )
        reset: tuple[bool, bool, bool] | None = None
        rediscovered: bool | None = None
        reload_verified: bool | None = None
        if comparison.equal and semantic_valid and auto_reset:
            # The three calls below are adjacent inside this exclusive Worker operation.
            progress(
                OperationProgress(
                    "eeprom-flash", "reset", 0, 1, "发送 ESC 复位序列", cancellable=False
                )
            )
            reset = ResetService(self.backend).reset_ecat(position)
            # A temporary drop after reset is expected and never rewrites the image result.
            rediscovered = self._rediscover(position)
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
                        progress=progress,
                        cancel=lambda: False,
                        progress_operation="eeprom-flash",
                        progress_stage="reload-verify",
                        cancellable=False,
                    )
                    reload_image = self.parser.parse(reload)
                    reload_verified = compare_images(target, reload).equal and self.semantic_matches(
                        reload_image, device
                    )
                except Exception:
                    reload_verified = False
        return EepromFlashResult(
            len(readback),
            total,
            comparison,
            sii_valid,
            semantic_valid,
            verification,
            reset,
            rediscovered,
            reload_verified,
        )

    def restore(self, position: int, backup_path: Path, **kwargs: object) -> EepromFlashResult:
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
