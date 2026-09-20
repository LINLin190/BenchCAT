from __future__ import annotations

import itertools
import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from enum import IntEnum, StrEnum
from typing import Any

from ..backends.base import DEFAULT_STATE_TRANSITION_TIMEOUT_US, EtherCatBackend
from ..models import EtherCatState, ProcessDataSnapshot, SlaveInfo


class Priority(IntEnum):
    CONTROL = 10
    NORMAL = 20
    WATCH = 50


class WorkerState(StrEnum):
    STARTING = "starting"
    READY = "ready"
    BUSY = "busy"
    STALLED = "stalled"
    STOPPING = "stopping"
    EXITED = "exited"


@dataclass(frozen=True, slots=True)
class WorkerEvent:
    kind: str
    payload: Any
    session_id: int | None = None


@dataclass(order=True, slots=True)
class _Task:
    priority: int
    sequence: int
    event_session_id: int | None = field(compare=False)
    future: Future[Any] = field(compare=False)
    operation: str | Callable[[EtherCatBackend], Any] = field(compare=False)
    args: tuple[Any, ...] = field(compare=False, default=())
    kwargs: dict[str, Any] = field(compare=False, default_factory=dict)


class EtherCatWorker:
    """The sole owner and scheduler of all calls made against one backend/master."""

    def __init__(self, backend_factory: Callable[[], EtherCatBackend], *, queue_limit: int = 32) -> None:
        self._backend_factory = backend_factory
        self._tasks: queue.PriorityQueue[_Task] = queue.PriorityQueue(maxsize=queue_limit)
        self._events: queue.SimpleQueue[WorkerEvent] = queue.SimpleQueue()
        # Process data is display state; only the newest pending cycle is useful.
        self._process_data_lock = threading.Lock()
        self._latest_process_data: WorkerEvent | None = None
        self._stop = threading.Event()
        self._seq = itertools.count()
        self._thread = threading.Thread(target=self._run, name="EtherCAT Worker", daemon=True)
        self._backend: EtherCatBackend | None = None
        self._cycle_period = 0.0
        self._cycle_timeout_us = 2000
        self._next_cycle = 0.0
        self._max_consecutive_errors = 5
        self._needs_safe_state = False
        self._cycle_session_id: int | None = None
        self._cycle_positions: set[int] = set()
        self._next_state_check = 0.0
        self._state = WorkerState.STARTING

    @property
    def state(self) -> WorkerState:
        return self._state

    @property
    def queue_depth(self) -> int:
        return self._tasks.qsize()

    def mark_stalled(self) -> None:
        self._state = WorkerState.STALLED

    @property
    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def start(self) -> None:
        if not self._thread.is_alive():
            self._thread.start()

    def submit(
        self,
        operation: str | Callable[[EtherCatBackend], Any],
        *args: Any,
        priority: Priority = Priority.NORMAL,
        event_session_id: int | None = None,
        **kwargs: Any,
    ) -> Future[Any]:
        future: Future[Any] = Future()
        if self._stop.is_set() or not self._thread.is_alive():
            future.set_exception(RuntimeError("EtherCAT Worker is not running"))
            return future
        if self._state is WorkerState.STALLED:
            future.set_exception(RuntimeError("EtherCAT Worker is stalled"))
            return future
        try:
            self._tasks.put_nowait(
                _Task(int(priority), next(self._seq), event_session_id, future, operation, args, kwargs)
            )
        except queue.Full:
            future.set_exception(RuntimeError("EtherCAT hardware queue is full"))
        return future

    def start_cycle(
        self,
        period_ms: float,
        timeout_us: int,
        max_consecutive_errors: int = 5,
        *,
        event_session_id: int | None = None,
    ) -> Future[Any]:
        return self.submit(
            "__start_cycle__",
            period_ms,
            timeout_us,
            max_consecutive_errors,
            priority=Priority.CONTROL,
            event_session_id=event_session_id,
        )

    def stop_cycle(self, *, event_session_id: int | None = None) -> Future[Any]:
        return self.submit(
            "__stop_cycle__", priority=Priority.CONTROL, event_session_id=event_session_id
        )

    def poll_events(self, limit: int = 100) -> list[WorkerEvent]:
        result: list[WorkerEvent] = []
        for _ in range(limit):
            try:
                result.append(self._events.get_nowait())
            except queue.Empty:
                break
        if len(result) < limit:
            with self._process_data_lock:
                if self._latest_process_data is not None:
                    result.append(self._latest_process_data)
                    self._latest_process_data = None
        return result

    def _publish_process_data(self, snapshot: ProcessDataSnapshot, session_id: int | None) -> None:
        with self._process_data_lock:
            self._latest_process_data = WorkerEvent("process_data", snapshot, session_id)

    def shutdown(self, timeout: float = 5.0) -> bool:
        self._state = WorkerState.STOPPING
        self._stop.set()
        try:
            self._tasks.put_nowait(_Task(-1, next(self._seq), None, Future(), "__wake__"))
        except queue.Full:
            pass
        self._thread.join(timeout)
        return not self._thread.is_alive()

    @staticmethod
    def _configure_cycle(
        backend: EtherCatBackend, period_ms: float, timeout_us: int, max_consecutive_errors: int,
        *, position: int | None = None,
    ) -> tuple[float, int, int, list[SlaveInfo], ProcessDataSnapshot]:
        if period_ms <= 0:
            raise ValueError("Cycle period must be positive")
        backend.map_process_data()
        backend.request_state(None, EtherCatState.SAFE_OP, DEFAULT_STATE_TRANSITION_TIMEOUT_US)
        first_snapshot = backend.exchange_process_data(timeout_us)
        slaves = backend.request_state(position, EtherCatState.OP, DEFAULT_STATE_TRANSITION_TIMEOUT_US)
        return period_ms / 1000.0, timeout_us, max_consecutive_errors, slaves, first_snapshot

    @staticmethod
    def _disable_cycle(backend: EtherCatBackend) -> object:
        for slave in backend.read_states():
            # SAFE-OP + ERROR is already safe. Do not acknowledge its fault
            # during cleanup; keep the AL code available until a user request.
            if slave.state is EtherCatState.SAFE_OP and (slave.raw_state or 0) & 0x10:
                continue
            backend.request_state(slave.position, EtherCatState.SAFE_OP, DEFAULT_STATE_TRANSITION_TIMEOUT_US)
        return backend.read_states()

    def _execute(self, task: _Task) -> None:
        if self._backend is None or not task.future.set_running_or_notify_cancel():
            return
        try:
            self._state = WorkerState.BUSY
            if task.operation == "__start_cycle__":
                result = self._configure_cycle(self._backend, *task.args, **task.kwargs)
                (
                    self._cycle_period,
                    self._cycle_timeout_us,
                    self._max_consecutive_errors,
                    slaves,
                    first_snapshot,
                ) = result
                self._needs_safe_state = True
                self._cycle_session_id = task.event_session_id
                self._next_cycle = time.perf_counter()
                self._next_state_check = self._next_cycle + 0.1
                self._cycle_positions = {s.position for s in slaves if s.state is EtherCatState.OP}
                self._publish_process_data(first_snapshot, task.event_session_id)
                self._events.put(WorkerEvent("cycle_started", slaves, task.event_session_id))
            elif task.operation == "__stop_cycle__":
                result = self._disable_cycle(self._backend)
                self._cycle_period = 0.0
                self._needs_safe_state = False
                self._events.put(WorkerEvent("cycle_stopped", result, self._cycle_session_id))
                self._cycle_session_id = None
            elif callable(task.operation):
                result = task.operation(self._backend, *task.args, **task.kwargs)
            elif task.operation == "__wake__":
                result = None
            else:
                result = getattr(self._backend, task.operation)(*task.args, **task.kwargs)
            task.future.set_result(result)
        except BaseException as exc:
            if task.operation == "__start_cycle__" and self._backend.connected:
                self._cycle_period = 0.0
                try:
                    self._disable_cycle(self._backend)
                    self._needs_safe_state = False
                    # The command lane publishes the failed start and its states.
                    # A later slaves_changed event would clear that failure.
                except Exception:
                    self._needs_safe_state = True
            elif task.operation == "__stop_cycle__":
                self._cycle_period = 0.0
                self._needs_safe_state = self._backend.connected
            task.future.set_exception(exc)
            self._events.put(WorkerEvent("error", exc, task.event_session_id))
        finally:
            if self._state is WorkerState.BUSY:
                self._state = WorkerState.READY

    def _run_cycle(self) -> None:
        assert self._backend is not None
        try:
            snapshot = self._backend.exchange_process_data(self._cycle_timeout_us)
            self._publish_process_data(snapshot, self._cycle_session_id)
            if time.perf_counter() >= self._next_state_check:
                slaves = self._backend.read_states()
                self._next_state_check = time.perf_counter() + 0.1
                for slave in slaves:
                    if slave.position in self._cycle_positions and (
                        slave.state is not EtherCatState.OP
                        or (slave.raw_state or 0) & 0x10
                        or slave.al_status
                    ):
                        raise RuntimeError(
                            f"从站 {slave.position} 已退出正常 OP："
                            f"AL state 0x{(slave.raw_state or int(slave.state)):02X}, "
                            f"AL code 0x{slave.al_status:04X}"
                        )
            if snapshot.consecutive_errors >= self._max_consecutive_errors:
                self._cycle_period = 0.0
                try:
                    slaves = self._disable_cycle(self._backend)
                    self._needs_safe_state = False
                    self._events.put(WorkerEvent("slaves_changed", slaves, self._cycle_session_id))
                except Exception:
                    pass
                self._events.put(WorkerEvent("cycle_fault", snapshot, self._cycle_session_id))
                self._cycle_session_id = None
        except BaseException as exc:
            self._cycle_period = 0.0
            try:
                slaves = self._disable_cycle(self._backend)
                self._needs_safe_state = False
                self._events.put(WorkerEvent("slaves_changed", slaves, self._cycle_session_id))
            except Exception:
                pass
            self._events.put(WorkerEvent("cycle_fault", exc, self._cycle_session_id))
            self._cycle_session_id = None

    def _run(self) -> None:
        try:
            self._backend = self._backend_factory()
        except BaseException as exc:
            self._state = WorkerState.EXITED
            self._events.put(WorkerEvent("worker_fatal", exc))
            while True:
                try:
                    task = self._tasks.get_nowait()
                except queue.Empty:
                    break
                if not task.future.done():
                    task.future.set_exception(RuntimeError(f"EtherCAT Worker failed to start: {exc}"))
            return
        self._state = WorkerState.READY
        self._events.put(WorkerEvent("ready", None))
        try:
            while not self._stop.is_set():
                # A late PDO exchange must never starve stop/control work. Since the
                # queue is priority ordered, a control task (if present) is always first.
                try:
                    control = self._tasks.get_nowait()
                except queue.Empty:
                    control = None
                if control is not None:
                    if control.priority <= int(Priority.CONTROL):
                        self._execute(control)
                        continue
                    self._tasks.put(control)
                now = time.perf_counter()
                if self._cycle_period and now >= self._next_cycle:
                    self._run_cycle()
                    self._next_cycle = max(self._next_cycle + self._cycle_period, time.perf_counter())
                    continue
                timeout = 0.05
                if self._cycle_period:
                    timeout = max(0.0, min(timeout, self._next_cycle - now))
                try:
                    task = self._tasks.get(timeout=timeout)
                except queue.Empty:
                    continue
                self._execute(task)
        finally:
            self._cycle_period = 0.0
            if self._backend.connected:
                try:
                    if self._needs_safe_state:
                        try:
                            self._disable_cycle(self._backend)
                        except Exception as exc:
                            self._events.put(WorkerEvent("error", exc))
                    self._backend.disconnect()
                except Exception as exc:
                    self._events.put(WorkerEvent("error", exc))
            self._events.put(WorkerEvent("stopped", None))
            self._state = WorkerState.EXITED
