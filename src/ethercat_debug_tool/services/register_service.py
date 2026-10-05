from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass

from ..backends.base import EtherCatBackend
from ..backends.passive_discovery import REGISTER_FRAME_DATAGRAMS, REGISTER_FRAME_PAYLOAD
from ..models import AccessSemantics, RegisterRead


@dataclass(frozen=True, slots=True)
class RegisterDefinition:
    address: int
    width: int
    name: str
    access: AccessSemantics
    group: str
    description: str


@dataclass(frozen=True, slots=True)
class RegisterWritePlan:
    position: int
    address: int
    semantics: AccessSemantics
    current: bytes
    target: bytes
    changed_mask: bytes
    known_register: bool
    definition_id: str | None = None


@dataclass(frozen=True, slots=True)
class RegisterWriteResult:
    fpwr_wkc: int
    readback: bytes | None
    verified: bool | None
    conclusion: str


def changed_mask(current: bytes, target: bytes) -> bytes:
    if len(current) != len(target):
        raise ValueError("Current and target widths differ")
    return bytes(a ^ b for a, b in zip(current, target, strict=True))


class RegisterService:
    def __init__(self, backend: EtherCatBackend) -> None:
        self.backend = backend

    def read(
        self,
        position: int,
        address: int,
        size: int,
        timeout_us: int = 2000,
        *,
        address_space: str = "esc_core",
        master_access_allowed: bool = True,
    ) -> RegisterRead:
        # Memory windows use the same absolute EtherCAT address space as core CSRs.
        if address_space not in {"esc_core", "user_ram", "process_ram"} or not master_access_allowed:
            raise PermissionError("This register is not reachable through the EtherCAT master register path")
        if not 1 <= size <= 256 or not 0 <= address <= 0xFFFF or address + size > 0x10000:
            raise ValueError("Register read must stay within 0x0000–0xFFFF and be 1–256 bytes")
        started = time.perf_counter()
        data = self.backend.register_read(position, address, size, timeout_us)
        return RegisterRead(position, address, data, 1, (time.perf_counter() - started) * 1000, time.time())

    @staticmethod
    def read_frames(requests: Iterable[tuple[int, int]]) -> list[list[tuple[int, int]]]:
        """Pack exact register widths, preserving one WKC per register."""
        frames: list[list[tuple[int, int]]] = []
        payload = 0
        for address, size in sorted(set(requests)):
            if not 1 <= size <= 256 or not 0 <= address < address + size <= 0x10000:
                raise ValueError("Invalid register read range")
            if not frames or len(frames[-1]) >= REGISTER_FRAME_DATAGRAMS or payload + size + 12 > REGISTER_FRAME_PAYLOAD:
                frames.append([])
                payload = 0
            frames[-1].append((address, size))
            payload += size + 12
        return frames

    def prepare_write(
        self,
        position: int,
        address: int,
        target: bytes,
        semantics: AccessSemantics,
        known_register: bool,
        expected_width: int | None = None,
        expected_semantics: AccessSemantics | None = None,
        definition_id: str | None = None,
        address_space: str = "esc_core",
        master_access_allowed: bool = True,
        direct_write_allowed: bool = True,
        timeout_us: int = 2000,
    ) -> RegisterWritePlan:
        if known_register and (address_space != "esc_core" or not master_access_allowed):
            raise PermissionError("This register is not reachable through the EtherCAT master register path")
        if known_register and not direct_write_allowed:
            raise PermissionError("Known register requires a dedicated safe operation and cannot be written directly")
        if semantics is AccessSemantics.RO:
            raise PermissionError("Read-only register cannot be written")
        if not 1 <= len(target) <= 256 or address < 0 or address + len(target) > 0x10000:
            raise ValueError("Register write must stay within 0x0000–0xFFFF and be 1–256 bytes")
        if known_register and expected_width is not None and len(target) != expected_width:
            raise ValueError(f"Known register write must be exactly {expected_width} bytes")
        if known_register and expected_semantics is not None and semantics is not expected_semantics:
            raise ValueError("Known register access semantics do not match the catalog definition")
        # A write-only register cannot be read safely (and some ESCs reject the
        # FPRD outright).  Other semantics still get a fresh value for the
        # confirmation dialog and concurrent-change guard.
        current = (
            b"" if semantics is AccessSemantics.WO else self.read(position, address, len(target), timeout_us).data
        )
        return RegisterWritePlan(
            position,
            address,
            semantics,
            current,
            bytes(target),
            b"" if semantics is AccessSemantics.WO else changed_mask(current, target),
            known_register,
            definition_id,
        )

    def execute_write(self, plan: RegisterWritePlan, timeout_us: int = 2000) -> RegisterWriteResult:
        if plan.semantics is not AccessSemantics.WO:
            current = self.read(plan.position, plan.address, len(plan.target), timeout_us).data
            if current != plan.current:
                raise RuntimeError("写入失败：寄存器当前值已变化，请重新操作。")
        self.backend.register_write(plan.position, plan.address, plan.target, timeout_us)
        if plan.semantics in {AccessSemantics.WO, AccessSemantics.SELF_CLEARING}:
            return RegisterWriteResult(1, None, None, "FPWR 成功，无法通过静态回读确认语义结果")
        readback = self.read(plan.position, plan.address, len(plan.target), timeout_us).data
        if plan.semantics is AccessSemantics.RW:
            valid = readback == plan.target
        elif plan.semantics is AccessSemantics.W1C:
            valid = all(
                (actual & requested) == 0 for actual, requested in zip(readback, plan.target, strict=True)
            )
        elif plan.semantics is AccessSemantics.W1S:
            valid = all(
                (actual & requested) == requested
                for actual, requested in zip(readback, plan.target, strict=True)
            )
        elif plan.semantics is AccessSemantics.WAC:
            valid = all(actual == 0 for actual in readback)
        elif plan.semantics is AccessSemantics.VOLATILE:
            return RegisterWriteResult(1, readback, None, "FPWR 成功；寄存器易变，不执行整值相等判断")
        else:
            valid = False
        return RegisterWriteResult(1, readback, valid, "写入并验证成功" if valid else "写入后校验失败")


class ResetService:
    """Must be called as one exclusive worker task after EEPROM image verification."""

    def __init__(self, backend: EtherCatBackend) -> None:
        self.backend = backend

    def reset_ecat(self, position: int, timeout_us: int = 2000) -> tuple[bool, bool, bool]:
        results: list[bool] = []
        for byte in b"RES":
            self.backend.register_write(position, 0x0040, bytes([byte]), timeout_us)
            results.append(True)
        return tuple(results)  # type: ignore[return-value]
