from __future__ import annotations

import threading
from collections.abc import Iterable
from dataclasses import replace

from .models import BackendMode, EtherCatState, MasterPhase, MasterSnapshot, SlaveInfo


class InvalidMasterTransition(RuntimeError):
    """Raised when a command attempts an impossible logical Master transition."""


class StaleMasterSession(RuntimeError):
    """Raised when an asynchronous result belongs to an expired Master session."""


class MasterStateMachine:
    """Authoritative logical state for the single pySOEM Master generation."""

    def __init__(self, mode: BackendMode) -> None:
        self._lock = threading.RLock()
        self._mode = mode
        self._phase = MasterPhase.DISCONNECTED
        self._adapter: str | None = None
        self._slaves: tuple[SlaveInfo, ...] = ()
        self._session_id = 0
        self._revision = 0
        self._last_error: str | None = None

    @property
    def mode(self) -> BackendMode:
        with self._lock:
            return self._mode

    @property
    def session_id(self) -> int:
        with self._lock:
            return self._session_id

    def snapshot(self) -> MasterSnapshot:
        with self._lock:
            return MasterSnapshot(
                mode=self._mode,
                phase=self._phase,
                adapter=self._adapter,
                connected=self._phase
                in {
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                    MasterPhase.CYCLIC,
                },
                cycle_running=self._phase is MasterPhase.CYCLIC,
                slaves=self._slaves,
                session_id=self._session_id,
                revision=self._revision,
                last_error=self._last_error,
            )

    def switch_mode(self, mode: BackendMode) -> None:
        with self._lock:
            self._require_phase("switch_mode", {MasterPhase.DISCONNECTED, MasterPhase.FAULTED})
            self._mode = mode
            self._replace(
                phase=MasterPhase.DISCONNECTED,
                adapter=None,
                slaves=(),
                last_error=None,
                advance_session=True,
            )

    def connect_succeeded(self, adapter: str) -> None:
        with self._lock:
            self._require_phase("connect_succeeded", {MasterPhase.DISCONNECTED})
            if not adapter:
                raise InvalidMasterTransition("connect_succeeded requires a non-empty adapter")
            self._replace(
                phase=MasterPhase.ADAPTER_OPEN,
                adapter=adapter,
                slaves=(),
                last_error=None,
                advance_session=True,
            )

    def connect_failed(self, message: str) -> None:
        with self._lock:
            self._require_phase(
                "connect_failed",
                {
                    MasterPhase.DISCONNECTED,
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                },
            )
            self._replace(
                phase=MasterPhase.DISCONNECTED,
                adapter=None,
                slaves=(),
                last_error=message,
                advance_session=True,
            )

    def disconnect_completed(self, message: str | None = None) -> None:
        with self._lock:
            self._require_phase(
                "disconnect_completed",
                {
                    MasterPhase.DISCONNECTED,
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                    MasterPhase.CYCLIC,
                },
            )
            self._replace(
                phase=MasterPhase.DISCONNECTED,
                adapter=None,
                slaves=(),
                last_error=message,
                advance_session=True,
            )

    def auto_scan_completed(self, adapter: str | None, slaves: Iterable[SlaveInfo]) -> None:
        with self._lock:
            self._require_phase(
                "auto_scan_completed",
                {
                    MasterPhase.DISCONNECTED,
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                },
            )
            values = tuple(slaves)
            if values and not adapter:
                raise InvalidMasterTransition("auto_scan_completed requires an adapter when slaves exist")
            self._replace(
                phase=MasterPhase.BUS_SCANNED if values else MasterPhase.DISCONNECTED,
                adapter=adapter if values else None,
                slaves=values,
                last_error=None,
                advance_session=True,
            )

    def scan_succeeded(self, slaves: Iterable[SlaveInfo]) -> None:
        with self._lock:
            self._require_phase(
                "scan_succeeded",
                {MasterPhase.ADAPTER_OPEN, MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED},
            )
            values = tuple(slaves)
            self._replace(
                phase=MasterPhase.BUS_SCANNED if values else MasterPhase.ADAPTER_OPEN,
                adapter=self._adapter,
                slaves=values,
                last_error=None,
                advance_session=True,
            )

    def scan_failed(self, message: str) -> None:
        with self._lock:
            self._require_phase(
                "scan_failed",
                {MasterPhase.ADAPTER_OPEN, MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED},
            )
            phase = MasterPhase.ADAPTER_OPEN
            self._replace(
                phase=phase,
                adapter=self._adapter,
                slaves=(),
                last_error=message,
                advance_session=True,
            )

    def states_updated(
        self,
        slaves: Iterable[SlaveInfo],
        *,
        expected_session: int | None = None,
        preserve_error: bool = False,
    ) -> bool:
        with self._lock:
            self._require_session(expected_session)
            self._require_phase(
                "states_updated",
                {
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                    MasterPhase.CYCLIC,
                },
            )
            values = tuple(slaves)
            phase = self._phase
            if not values:
                if phase is MasterPhase.CYCLIC:
                    raise InvalidMasterTransition(
                        "cyclic Master cannot lose all slaves without a confirmed stop or fault"
                    )
                phase = MasterPhase.ADAPTER_OPEN
            elif phase not in {MasterPhase.PDO_CONFIGURED, MasterPhase.CYCLIC}:
                phase = MasterPhase.BUS_SCANNED if values else MasterPhase.ADAPTER_OPEN
            elif phase is MasterPhase.PDO_CONFIGURED and any(
                slave.state in {EtherCatState.INIT, EtherCatState.PRE_OP} for slave in values
            ):
                phase = MasterPhase.BUS_SCANNED
            topology_changed = self._topology(self._slaves) != self._topology(values)
            if self._phase is MasterPhase.CYCLIC and topology_changed:
                raise InvalidMasterTransition(
                    "cyclic Master cannot change topology without a confirmed stop or fault"
                )
            self._replace(
                phase=phase,
                adapter=self._adapter,
                slaves=values,
                last_error=self._last_error if preserve_error else None,
                advance_session=topology_changed,
            )
            return topology_changed

    def pdo_configured(
        self, slaves: Iterable[SlaveInfo], *, expected_session: int | None = None
    ) -> None:
        with self._lock:
            self._require_session(expected_session)
            self._require_phase(
                "pdo_configured", {MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED}
            )
            values = tuple(slaves)
            if not values:
                raise InvalidMasterTransition("pdo_configured requires at least one slave")
            self._replace(
                phase=MasterPhase.PDO_CONFIGURED,
                adapter=self._adapter,
                slaves=values,
                last_error=None,
            )

    def state_read_failed(self, message: str, *, expected_session: int | None = None) -> None:
        with self._lock:
            self._require_session(expected_session)
            if self._phase is MasterPhase.FAULTED:
                return
            self._require_phase(
                "state_read_failed",
                {
                    MasterPhase.DISCONNECTED,
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                    MasterPhase.CYCLIC,
                },
            )
            # A failed read does not prove that PDO exchange stopped or topology
            # disappeared. Preserve the last confirmed state until the Worker
            # confirms a safe stop or the generation is faulted.
            self._replace(
                phase=self._phase,
                adapter=self._adapter,
                slaves=tuple(replace(slave, state_error=message) for slave in self._slaves),
                last_error=message,
            )

    def topology_changed(self, slaves: Iterable[SlaveInfo], message: str | None = None) -> None:
        with self._lock:
            self._require_phase(
                "topology_changed",
                {
                    MasterPhase.ADAPTER_OPEN,
                    MasterPhase.BUS_SCANNED,
                    MasterPhase.PDO_CONFIGURED,
                },
            )
            values = tuple(slaves)
            phase = MasterPhase.BUS_SCANNED if values else MasterPhase.ADAPTER_OPEN
            self._replace(
                phase=phase,
                adapter=self._adapter,
                slaves=values,
                last_error=message,
                advance_session=True,
            )

    def cycle_started(
        self, slaves: Iterable[SlaveInfo], *, expected_session: int | None = None
    ) -> None:
        with self._lock:
            self._require_session(expected_session)
            self._require_phase(
                "cycle_started",
                {MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED, MasterPhase.CYCLIC},
            )
            values = tuple(slaves)
            if not values:
                raise InvalidMasterTransition("cycle_started requires at least one slave")
            self._replace(
                phase=MasterPhase.CYCLIC,
                adapter=self._adapter,
                slaves=values,
                last_error=None,
            )

    def cycle_stopped(
        self, slaves: Iterable[SlaveInfo], *, expected_session: int | None = None
    ) -> None:
        with self._lock:
            self._require_session(expected_session)
            self._require_phase(
                "cycle_stopped",
                {MasterPhase.CYCLIC, MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED},
            )
            values = tuple(slaves)
            self._replace(
                phase=MasterPhase.BUS_SCANNED if values else MasterPhase.ADAPTER_OPEN,
                adapter=self._adapter,
                slaves=values,
                last_error=None,
            )

    def cycle_faulted(
        self,
        message: str,
        slaves: Iterable[SlaveInfo] | None = None,
        *,
        expected_session: int | None = None,
    ) -> None:
        with self._lock:
            self._require_session(expected_session)
            self._require_phase(
                "cycle_faulted",
                {MasterPhase.CYCLIC, MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED},
            )
            values = self._slaves if slaves is None else tuple(slaves)
            self._replace(
                phase=MasterPhase.BUS_SCANNED if values else MasterPhase.ADAPTER_OPEN,
                adapter=self._adapter,
                slaves=values,
                last_error=message,
            )

    def faulted(self, message: str) -> None:
        with self._lock:
            self._replace(
                phase=MasterPhase.FAULTED,
                adapter=None,
                slaves=(),
                last_error=message,
                advance_session=self._phase is not MasterPhase.FAULTED,
            )

    def _require_phase(self, action: str, allowed: set[MasterPhase]) -> None:
        if self._phase not in allowed:
            allowed_values = ", ".join(sorted(phase.value for phase in allowed))
            raise InvalidMasterTransition(
                f"{action} is invalid from {self._phase.value}; expected one of: {allowed_values}"
            )

    def _require_session(self, expected_session: int | None) -> None:
        if expected_session is not None and expected_session != self._session_id:
            raise StaleMasterSession(
                f"event belongs to session {expected_session}, current session is {self._session_id}"
            )

    @staticmethod
    def _topology(slaves: tuple[SlaveInfo, ...]) -> tuple[tuple[int, int, int, int, int, int | None], ...]:
        return tuple(
            (
                slave.position,
                slave.identity.vendor_id,
                slave.identity.product_code,
                slave.identity.revision,
                slave.identity.serial_number,
                slave.configured_address,
            )
            for slave in slaves
        )

    def _replace(
        self,
        *,
        phase: MasterPhase,
        adapter: str | None,
        slaves: tuple[SlaveInfo, ...],
        last_error: str | None,
        advance_session: bool = False,
    ) -> None:
        self._assert_invariants(phase, adapter, slaves)
        next_values = (phase, adapter, slaves, last_error)
        current_values = (self._phase, self._adapter, self._slaves, self._last_error)
        if not advance_session and next_values == current_values:
            return
        self._phase, self._adapter, self._slaves, self._last_error = next_values
        if advance_session:
            self._session_id += 1
        self._revision += 1

    @staticmethod
    def _assert_invariants(
        phase: MasterPhase, adapter: str | None, slaves: tuple[SlaveInfo, ...]
    ) -> None:
        if phase in {MasterPhase.DISCONNECTED, MasterPhase.FAULTED}:
            if adapter is not None or slaves:
                raise InvalidMasterTransition(f"{phase.value} cannot retain an adapter or slaves")
            return
        if not adapter:
            raise InvalidMasterTransition(f"{phase.value} requires an open adapter")
        if phase is MasterPhase.ADAPTER_OPEN and slaves:
            raise InvalidMasterTransition("adapter_open cannot retain scanned slaves")
        if phase in {MasterPhase.BUS_SCANNED, MasterPhase.PDO_CONFIGURED, MasterPhase.CYCLIC} and not slaves:
            raise InvalidMasterTransition(f"{phase.value} requires at least one slave")
