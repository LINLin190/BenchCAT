from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum, StrEnum
from pathlib import Path


class BackendMode(StrEnum):
    DEMO = "demo"
    REAL = "real"


class MasterPhase(StrEnum):
    DISCONNECTED = "disconnected"
    ADAPTER_OPEN = "adapter_open"
    BUS_SCANNED = "bus_scanned"
    PDO_CONFIGURED = "pdo_configured"
    CYCLIC = "cyclic"
    FAULTED = "faulted"


class EtherCatState(IntEnum):
    NONE = 0x00
    INIT = 0x01
    PRE_OP = 0x02
    BOOT = 0x03
    SAFE_OP = 0x04
    OP = 0x08

    @property
    def label(self) -> str:
        return {self.PRE_OP: "PRE-OP", self.SAFE_OP: "SAFE-OP"}.get(self, self.name)


class PdoDirection(StrEnum):
    RX = "rx"
    TX = "tx"


@dataclass(frozen=True, slots=True)
class AdapterInfo:
    name: str
    description: str


@dataclass(frozen=True, slots=True)
class SlaveIdentity:
    vendor_id: int
    product_code: int
    revision: int
    serial_number: int = 0


@dataclass(frozen=True, slots=True)
class SlaveInfo:
    position: int
    name: str
    identity: SlaveIdentity
    state: EtherCatState
    al_status: int
    input_size: int | None
    output_size: int | None
    configured_address: int | None = None
    chip_model: str = "Generic ESC"
    register_family: str = "GENERIC"
    raw_state: int | None = None
    pdi_type: int | None = None
    pdo_size_source: str = "mapped"
    esc_hardware: str | None = None
    esc_hardware_error: str | None = None
    eeprom_status: int | None = None
    eeprom_status_error: str | None = None
    eeprom_prefix: str | None = None
    eeprom_prefix_error: str | None = None
    product_type: str | None = None
    product_model: str | None = None


@dataclass(frozen=True, slots=True)
class MasterSnapshot:
    mode: BackendMode
    phase: MasterPhase
    adapter: str | None
    connected: bool
    cycle_running: bool
    slaves: tuple[SlaveInfo, ...]
    session_id: int
    revision: int
    last_error: str | None = None


@dataclass(frozen=True, slots=True)
class PdoEntry:
    direction: PdoDirection
    pdo_index: int
    index: int
    subindex: int
    bit_length: int
    bit_offset: int
    name: str | None = None
    data_type: str | None = None

    @property
    def byte_offset(self) -> int:
        return self.bit_offset // 8

    @property
    def bit_in_byte(self) -> int:
        return self.bit_offset % 8


@dataclass(frozen=True, slots=True)
class ObjectDictionaryEntry:
    index: int
    subindex: int
    name: str
    data_type: int | str
    bit_length: int
    access: int | str
    source: str = "online"


@dataclass(frozen=True, slots=True)
class ProcessDataSnapshot:
    inputs: tuple[bytes, ...]
    outputs: tuple[bytes, ...]
    actual_wkc: int
    expected_wkc: int
    cycle_count: int
    timeout_count: int
    wkc_error_count: int
    consecutive_errors: int
    timestamp: float


@dataclass(frozen=True, slots=True)
class EepromBackup:
    binary_path: Path
    sha256: str
    size: int


@dataclass(frozen=True, slots=True)
class OperationProgress:
    operation: str
    stage: str
    completed: int
    total: int
    detail: str = ""
    cancellable: bool = True


@dataclass(frozen=True, slots=True)
class RegisterRead:
    position: int
    address: int
    data: bytes
    wkc: int
    duration_ms: float
    timestamp: float


class AccessSemantics(StrEnum):
    RO = "RO"
    RW = "RW"
    WO = "WO"
    W1C = "W1C"
    W1S = "W1S"
    WAC = "WAC"
    SELF_CLEARING = "SELF_CLEARING"
    VOLATILE = "VOLATILE"
