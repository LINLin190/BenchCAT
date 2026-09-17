from __future__ import annotations

import dataclasses
import hashlib
import itertools
import json
import os
import queue
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from .backends.mock import MockBackend
from .backends.pysoem_backend import PysoemBackend
from .command_registry import CommandSpec, load_command_registry
from .esc_profiles.profiles import ProfileRegistry
from .esi import EsiParser
from .framing import FrameError, IncrementalFrameReader, write_frame
from .infrastructure import AuditLogger, default_audit_path
from .master_state import MasterStateMachine, StaleMasterSession
from .models import AccessSemantics, BackendMode, EtherCatState, OperationProgress, PdoDirection
from .services.eeprom_service import EepromService, compare_images
from .services.register_service import RegisterService, RegisterWritePlan, ResetService
from .sii.generator import SiiGenerationReport, SiiGenerator
from .sii.parser import SiiParser, crc8
from .worker import EtherCatWorker
from .worker.ethercat_worker import Priority

AUTO_SCAN_ADAPTER_TIMEOUT_S = 4.0


def _default_esi_library_path() -> Path | None:
    configured = os.environ.get("BENCHCAT_ESI_LIBRARY")
    if configured:
        return Path(configured).resolve()
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "xml列表"
        if candidate.is_dir():
            return candidate
    return None


def _json_value(value: Any) -> Any:
    if isinstance(value, BaseException):
        return str(value)
    if dataclasses.is_dataclass(value):
        return {field.name: _json_value(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, bytes):
        return value.hex(" ").upper()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    return value


def _ordered_adapters(adapters: list[Any], preferred_adapter: str = "") -> list[Any]:
    virtual = re.compile(r"\b(wan miniport|wi-?fi|wireless|loopback|vmware|virtual|wintun|tunnel)\b", re.I)
    ethernet = re.compile(r"\b(ethernet|gbe|gigabit|i21\d|realtek|ethercat)\b", re.I)

    def adapter_priority(item: Any) -> int:
        description = str(getattr(item, "description", ""))
        if virtual.search(description):
            return 2
        if ethernet.search(description):
            return 0
        return 1

    ordered = sorted(adapters, key=adapter_priority)
    preferred = next((item for item in adapters if item.name == preferred_adapter), None)
    if preferred is not None:
        ordered = [preferred, *(item for item in ordered if item.name != preferred_adapter)]
    return ordered


def _scan_adapter(backend: Any, adapter_name: str) -> tuple[dict[str, Any], list[Any]]:
    """Run one bounded-by-caller adapter attempt and leave it connected only on success."""
    started = time.perf_counter()
    attempt: dict[str, Any] = {"adapter": adapter_name, "slave_count": 0}
    slaves: list[Any] = []
    if backend.connected:
        backend.disconnect()
    try:
        backend.connect(adapter_name)
        slaves = list(backend.scan())
        attempt["slave_count"] = len(slaves)
    except Exception as exc:
        attempt["error"] = str(exc)
    finally:
        if not slaves and backend.connected:
            try:
                backend.disconnect()
            except Exception as exc:
                attempt["disconnect_error"] = str(exc)
        attempt["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    return attempt, slaves


class JsonWriter:
    """Single-owner response-pipe writer with bounded, non-blocking producers."""

    def __init__(self, stream: Any | None = None, max_frame_bytes: int | None = None) -> None:
        self._stream = stream
        self._max_frame_bytes = max_frame_bytes or load_command_registry().max_frame_bytes
        self._queue: queue.PriorityQueue[tuple[int, int, dict[str, Any] | None]] = (
            queue.PriorityQueue(maxsize=128)
        )
        self._sequence = itertools.count()
        self._failed = threading.Event()
        self._error: BaseException | None = None
        self._thread: threading.Thread | None = None
        if stream is not None:
            self._thread = threading.Thread(
                target=self._run, name="Bridge response writer", daemon=True
            )
            self._thread.start()

    @property
    def failed(self) -> bool:
        return self._failed.is_set()

    @property
    def error(self) -> BaseException | None:
        return self._error

    def _run(self) -> None:
        assert self._stream is not None
        try:
            while True:
                _, _, message = self._queue.get()
                try:
                    if message is None:
                        return
                    write_frame(self._stream, message, self._max_frame_bytes)
                finally:
                    self._queue.task_done()
        except BaseException as exc:
            self._error = exc
            self._failed.set()
        finally:
            try:
                self._stream.close()
            except OSError:
                pass

    def send(self, message: dict[str, Any]) -> None:
        safe = _json_value(message)
        if self._stream is None:
            # Kept only as an injectable test sink. Production always supplies
            # the dedicated response pipe.
            return
        if self._failed.is_set():
            raise OSError(f"response pipe writer failed: {self._error}")
        is_heartbeat = safe.get("type") == "event" and safe.get("payload", {}).get("kind") == "heartbeat"
        item = (1 if is_heartbeat else 0, next(self._sequence), safe)
        try:
            if is_heartbeat:
                self._queue.put_nowait(item)
            else:
                self._queue.put(item, timeout=0.25)
        except queue.Full:
            if not is_heartbeat:
                raise RuntimeError("response pipe queue is full") from None

    def close(self, timeout: float = 1.0) -> None:
        if self._thread is None or self._failed.is_set():
            return
        try:
            self._queue.put((2, next(self._sequence), None), timeout=0.25)
        except queue.Full:
            return
        self._thread.join(timeout)

    def event(self, kind: str, payload: Any, session_id: int | None = None) -> None:
        event = {"kind": kind, "data": payload}
        if session_id is not None:
            event["session_id"] = session_id
        self.send({"type": "event", "payload": event})


class EepromExclusiveError(RuntimeError):
    """Raised when a hardware command is rejected during an EEPROM write/restore."""


def _structured_error(
    exc: BaseException,
    *,
    request_id: int,
    method: str,
    spec: CommandSpec | None,
    session_id: int,
    snapshot: Any | None = None,
) -> dict[str, Any]:
    if exc.__class__.__name__ == "EepromOperationCancelled":
        code = "CANCELLED"
    elif isinstance(exc, EepromExclusiveError):
        code = "EEPROM_BUSY"
    elif "expired EtherCAT session" in str(exc):
        code = "SESSION_CHANGED"
    elif isinstance(exc, TimeoutError):
        code = "WORKER_STALLED"
    elif isinstance(exc, (ValueError, KeyError, PermissionError)):
        code = "VALIDATION"
    elif "queue is full" in str(exc):
        code = "QUEUE_FULL"
    else:
        code = "COMMUNICATION"
    mutating = bool(spec and spec.mutating)
    error = {
        "code": code,
        "message": str(exc),
        "category": (
            "validation" if code == "VALIDATION" else "busy" if code == "EEPROM_BUSY" else "transport"
        ),
        "recoverable": code not in {"WORKER_STALLED"},
        "session_invalidated": code == "WORKER_STALLED",
        "operation_result": "unknown" if mutating and code in {"WORKER_STALLED", "COMMUNICATION"} else "failed",
        "request_id": request_id,
        "method": method,
        "session_id": session_id,
    }
    if snapshot is not None:
        error["snapshot"] = snapshot
    return error


@dataclasses.dataclass(frozen=True, slots=True)
class _StoredRegisterPlan:
    plan: RegisterWritePlan
    session_id: int
    slave_signature: tuple[int, int, int, int, int | None]
    created_at: float


class BridgeRuntime:
    """Long-lived JSON bridge. The Worker remains the sole EtherCAT Master owner."""

    def __init__(
        self,
        writer: JsonWriter,
        mode: BackendMode = BackendMode.REAL,
        *,
        audit_path: Path | None = None,
        stability_wait_s: float = 0.5,
        rediscovery_timeout_s: float = 3.0,
        rediscovery_poll_s: float = 0.1,
    ) -> None:
        self.writer = writer
        self.registry = load_command_registry()
        self.master_state = MasterStateMachine(mode)
        self.worker = self._new_worker(self.mode)
        self.cancel = threading.Event()
        self.documents: dict[str, Any] = {}
        self.targets: dict[str, tuple[bytes, Any]] = {}
        self.write_plans: dict[str, _StoredRegisterPlan] = {}
        self.profiles = ProfileRegistry()
        self.audit = AuditLogger(audit_path)
        self.stability_wait_s = stability_wait_s
        self.rediscovery_timeout_s = rediscovery_timeout_s
        self.rediscovery_poll_s = rediscovery_poll_s
        self._command_lock = threading.Lock()
        self._admission_lock = threading.Lock()
        self._eeprom_exclusive = False
        self._worker_lock = threading.Lock()
        self._active_hardware_session: int | None = None
        self._worker_stalled = False
        self._stopped = threading.Event()
        self._events = threading.Thread(target=self._event_loop, name="Bridge events", daemon=True)
        self._events.start()

    @staticmethod
    def _new_worker(mode: BackendMode) -> EtherCatWorker:
        worker = EtherCatWorker(
            MockBackend if mode is BackendMode.DEMO else PysoemBackend,
            queue_limit=load_command_registry().hardware_queue,
        )
        worker.start()
        return worker

    @property
    def mode(self) -> BackendMode:
        return self.master_state.mode

    @property
    def connected(self) -> bool:
        return self.master_state.snapshot().connected

    @property
    def cycle_running(self) -> bool:
        return self.master_state.snapshot().cycle_running

    @property
    def slaves(self) -> list[Any]:
        return list(self.master_state.snapshot().slaves)

    @property
    def session_id(self) -> int:
        return self.master_state.session_id

    def snapshot(self) -> dict[str, Any]:
        snapshot = self.master_state.snapshot()
        return {
            "mode": snapshot.mode.value,
            "phase": snapshot.phase.value,
            "adapter": snapshot.adapter,
            "connected": snapshot.connected,
            "cycle_running": snapshot.cycle_running,
            "slaves": list(snapshot.slaves),
            "session_id": snapshot.session_id,
            "revision": snapshot.revision,
            "last_error": snapshot.last_error,
            "worker_healthy": not self._worker_stalled,
            "worker_state": self.worker.state.value,
            "queue_depth": self.worker.queue_depth,
        }

    def _publish_snapshot(self) -> None:
        snapshot = self.snapshot()
        self.writer.event("bus_snapshot", snapshot, snapshot["session_id"])

    def _session_changed(self) -> None:
        self.write_plans.clear()
        self._publish_snapshot()

    def _fault_worker(self, reason: str) -> None:
        with self._worker_lock:
            if self._worker_stalled:
                return
            self._worker_stalled = True
            self.worker.mark_stalled()
        self.master_state.faulted(reason)
        self._session_changed()
        self.writer.event(
            "worker_stalled", {"reason": reason, "session_id": self.session_id}, self.session_id
        )

    def _event_loop(self) -> None:
        while not self._stopped.wait(0.02):
            with self._worker_lock:
                worker = self.worker
            for event in worker.poll_events():
                try:
                    if event.session_id is not None and event.session_id != self.session_id:
                        continue
                    # Start/stop results are committed by the command lane. A delayed
                    # event must not overwrite a subsequent requested slave state.
                    if event.kind == "cycle_fault":
                        self.master_state.cycle_faulted(
                            str(event.payload), expected_session=event.session_id
                        )
                    elif event.kind == "slaves_changed":
                        if self.master_state.states_updated(
                            event.payload or (), expected_session=event.session_id
                        ):
                            self.write_plans.clear()
                    elif event.kind == "worker_fatal":
                        with self._worker_lock:
                            self._worker_stalled = True
                        self.master_state.faulted(str(event.payload))
                        self.write_plans.clear()
                    if event.kind in {
                        "cycle_started",
                        "cycle_stopped",
                        "cycle_fault",
                        "slaves_changed",
                        "worker_fatal",
                    }:
                        self._publish_snapshot()
                    self.writer.event(event.kind, event.payload, event.session_id)
                except StaleMasterSession:
                    continue
                except BaseException:
                    # A malformed event or a transient writer failure must not
                    # terminate the only thread forwarding Worker state changes.
                    continue

    def _submit(
        self,
        operation: str | Any,
        *args: Any,
        priority: Priority = Priority.NORMAL,
        timeout: float = 15.0,
        fault_on_timeout: bool = True,
        **kwargs: Any,
    ) -> Any:
        with self._worker_lock:
            if self._worker_stalled:
                raise RuntimeError(
                    "EtherCAT Worker 此前发生不可中断的通信超时；为避免请求继续堆积，请重新启动应用"
                )
            future = self.worker.submit(
                operation,
                *args,
                priority=priority,
                event_session_id=self.session_id,
                **kwargs,
            )
        try:
            return future.result(timeout=timeout)
        except FutureTimeoutError as exc:
            # A queued task can be cancelled safely. If it is already running,
            # pySOEM may still be blocked in native code; fail subsequent requests
            # immediately instead of building a minutes-long queue behind it.
            if not future.cancel() and fault_on_timeout:
                self._fault_worker(f"EtherCAT Worker 操作超时（{timeout:g} 秒）")
            raise TimeoutError(f"EtherCAT Worker 操作超时（{timeout:g} 秒）") from exc

    def _auto_scan(self, preferred_adapter: str) -> dict[str, Any]:
        adapters = list(self._submit("enumerate_adapters"))
        ordered = _ordered_adapters(adapters, preferred_adapter)
        attempts: list[dict[str, Any]] = []
        for item in ordered:
            description = str(getattr(item, "description", "") or item.name)
            self.writer.event(
                "auto_scan_attempt",
                {"adapter": item.name, "description": description, "state": "started"},
                self.session_id,
            )
            started = time.perf_counter()
            try:
                attempt, slaves = self._submit(
                    lambda backend, name=item.name: _scan_adapter(backend, name),
                    timeout=AUTO_SCAN_ADAPTER_TIMEOUT_S,
                    fault_on_timeout=False,
                )
            except TimeoutError as exc:
                attempt = {
                    "adapter": item.name,
                    "slave_count": 0,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000),
                    "timed_out": True,
                    "error": f"网卡 {description} 探测超过 {AUTO_SCAN_ADAPTER_TIMEOUT_S:g} 秒",
                }
                attempts.append(attempt)
                self.writer.event(
                    "auto_scan_attempt",
                    {**attempt, "description": description, "state": "timed_out"},
                    self.session_id,
                )
                self._fault_worker(attempt["error"])
                raise TimeoutError(attempt["error"]) from exc

            attempts.append(attempt)
            self.writer.event(
                "auto_scan_attempt",
                {**attempt, "description": description, "state": "completed"},
                self.session_id,
            )
            if slaves:
                return {
                    "adapters": adapters,
                    "selected_adapter": item.name,
                    "connected": True,
                    "slaves": slaves,
                    "attempts": attempts,
                }

        selected = preferred_adapter if any(item.name == preferred_adapter for item in adapters) else ""
        if not selected and ordered:
            selected = ordered[0].name
        return {
            "adapters": adapters,
            "selected_adapter": selected,
            "connected": False,
            "slaves": [],
            "attempts": attempts,
        }

    def _progress(self, progress: OperationProgress) -> None:
        self.writer.event("progress", progress, self._active_hardware_session)

    def _audited(self, action: str, details: dict[str, Any], operation: Any) -> Any:
        try:
            result = operation()
        except BaseException as exc:
            self.audit.record(action, details, outcome="failed", error=str(exc))
            raise
        self.audit.record(action, details, outcome="succeeded")
        return result

    def _slave(self, position: int) -> Any:
        if not 1 <= position <= len(self.slaves):
            raise ValueError(f"Slave {position} is not available")
        return self.slaves[position - 1]

    def _ensure_slave_init(self, position: int, operation: str) -> tuple[Any, bool]:
        slave = self._slave(position)
        if slave.state is EtherCatState.INIT:
            return slave, False
        self._progress(
            OperationProgress(operation, "prepare-init", 0, 1, "正在将目标从站切换到 INIT", True)
        )
        slaves = list(self._submit("request_state", position, EtherCatState.INIT, 2_000_000))
        current = next((item for item in slaves if item.position == position), None)
        if current is None or current.state is not EtherCatState.INIT:
            actual = current.state.name if current is not None else "未发现"
            raise RuntimeError(f"从站 {position} 未能进入 INIT，当前状态：{actual}")
        if self.master_state.states_updated(slaves):
            self.write_plans.clear()
        self._publish_snapshot()
        self._progress(
            OperationProgress(operation, "prepare-init", 1, 1, "目标从站已进入 INIT", True)
        )
        return current, True

    def _slave_signature(self, position: int) -> tuple[int, int, int, int, int | None]:
        slave = self._slave(position)
        identity = slave.identity
        return (
            int(identity.vendor_id),
            int(identity.product_code),
            int(identity.revision),
            int(identity.serial_number),
            slave.configured_address,
        )

    def _register_definition(
        self, params: dict[str, Any], *, default_position: Any | None = None
    ) -> dict[str, Any] | None:
        """Resolve only against the selected slave's profile, never by address alone."""
        raw_position = params.get("position", default_position)
        if raw_position is None:
            return None
        position = int(raw_position)
        registry = self.profiles
        chip_model = self._register_profile(params, position, registry)
        definition_id = params.get("definition_id")
        if definition_id:
            return registry.definition(chip_model, str(definition_id))
        # Compatibility for callers predating definition_id.  The UI always
        # sends it; this fallback is still profile- and esc-core-scoped.
        if "address" in params:
            return registry.find(chip_model, "esc_core", int(params["address"]))
        return None

    def _register_profile(
        self, params: dict[str, Any], position: int, registry: ProfileRegistry | None = None
    ) -> str:
        """Return the user-selected documentation profile, falling back to detected hardware."""
        registry = registry or self.profiles
        requested = params.get("profile")
        if requested is None:
            return self._slave(position).chip_model
        profile = registry.get(str(requested))
        if profile.chip_model != requested:
            raise ValueError(f"Unknown register profile: {requested}")
        return profile.chip_model

    @staticmethod
    def _require_master_read(definition: dict[str, Any]) -> None:
        if definition["address_space"] != "esc_core" or not definition["master_access_allowed"]:
            raise PermissionError(
                "This register is local to the PDI/HBI/PHY or otherwise unavailable through EtherCAT FPRD"
            )

    @staticmethod
    def _require_definition_range(params: dict[str, Any], definition: dict[str, Any]) -> None:
        if int(params["address"]) != int(definition["address"]):
            raise ValueError("Register address does not match the selected definition")
        requested_size = params.get("size")
        if requested_size is not None and int(requested_size) != int(definition["width"]):
            raise ValueError("Register width does not match the selected definition")

    def dispatch(
        self, method: str, params: dict[str, Any], *, deadline_at_ms: int | None = None
    ) -> Any:
        spec = self.registry.require(method)
        if deadline_at_ms is not None and time.time_ns() // 1_000_000 >= deadline_at_ms:
            raise TimeoutError("request expired before execution")
        if method == "cancel":
            self.cancel.set()
            return {"cancelled": True}
        if method == "status":
            return self.snapshot()
        if spec.lane == "metadata":
            # Local metadata must remain available even while native hardware is
            # blocked. It never receives a backend/Master reference.
            return self._dispatch_serial(method, params)
        if method == "shutdown":
            self.shutdown()
            return {"stopped": True}
        exclusive_owner = method in {"eeprom_flash", "eeprom_restore"}
        with self._admission_lock:
            if self._eeprom_exclusive:
                raise EepromExclusiveError("EEPROM 正在烧录或恢复，其他硬件命令已被拒绝")
            if exclusive_owner:
                # Reserve exclusivity before waiting for the serial command lock so
                # requests admitted afterwards never sit behind a long EEPROM write.
                self._eeprom_exclusive = True
        try:
            with self._command_lock:
                if not exclusive_owner:
                    # Close the race where this request passed admission immediately
                    # before an EEPROM request reserved exclusivity.
                    with self._admission_lock:
                        if self._eeprom_exclusive:
                            raise EepromExclusiveError("EEPROM 正在烧录或恢复，其他硬件命令已被拒绝")
                if deadline_at_ms is not None and time.time_ns() // 1_000_000 >= deadline_at_ms:
                    raise TimeoutError("request expired while waiting in the hardware queue")
                self._active_hardware_session = self.session_id
                try:
                    return self._dispatch_serial(method, params)
                finally:
                    self._active_hardware_session = None
        finally:
            if exclusive_owner:
                with self._admission_lock:
                    self._eeprom_exclusive = False

    def _dispatch_serial(self, method: str, params: dict[str, Any]) -> Any:
        if method == "switch_mode":
            mode = BackendMode(params["mode"])
            if self.connected or self.cycle_running:
                raise RuntimeError("切换模式前必须停止周期通信并断开网卡")
            with self._worker_lock:
                old_worker = self.worker
                if not old_worker.shutdown():
                    raise RuntimeError("旧 EtherCAT Worker 无法安全退出；拒绝创建第二个 Master，请重启应用")
                self.worker = self._new_worker(mode)
                self._worker_stalled = False
            self.master_state.switch_mode(mode)
            self._session_changed()
            return {"mode": mode.value}
        if method == "enumerate_adapters":
            return self._submit("enumerate_adapters")
        if method == "auto_scan":
            if self.connected or self.cycle_running:
                raise RuntimeError("自动扫描前必须先断开当前网卡")
            preferred = str(params.get("preferred_adapter") or "")
            try:
                result = self._auto_scan(preferred)
            except BaseException as exc:
                if not self._worker_stalled:
                    self.master_state.connect_failed(str(exc))
                    self._session_changed()
                raise
            selected = str(result["selected_adapter"]) if result["connected"] else None
            self.master_state.auto_scan_completed(selected, result["slaves"])
            self._session_changed()
            return result
        if method == "connect":
            if self.connected:
                raise RuntimeError("Master 已连接；请先断开当前网卡")
            adapter = str(params["adapter"])
            try:
                self._submit("connect", adapter)
            except BaseException as exc:
                if not self._worker_stalled:
                    self.master_state.connect_failed(str(exc))
                    self._session_changed()
                raise
            self.master_state.connect_succeeded(adapter)
            self._session_changed()
            return {"connected": True}
        if method == "disconnect":
            failure: BaseException | None = None
            if self.cycle_running:
                try:
                    self._submit("__stop_cycle__", priority=Priority.CONTROL, timeout=10)
                except BaseException as exc:
                    self._fault_worker(f"断开前无法安全停止周期通信：{exc}")
                    raise
            try:
                self._submit("disconnect")
            except BaseException as exc:
                failure = exc
            finally:
                if not self._worker_stalled:
                    self.master_state.disconnect_completed(str(failure) if failure is not None else None)
                    self._session_changed()
            if failure is not None:
                raise failure
            return {"connected": False}
        if method == "scan":
            if self.cycle_running:
                raise RuntimeError("周期通信运行时不能重新扫描，请先停止周期通信")
            if not self.connected:
                raise RuntimeError("Master 未连接，无法扫描从站")
            try:
                slaves = list(self._submit("scan", timeout=30))
            except BaseException as exc:
                if not self._worker_stalled:
                    self.master_state.scan_failed(str(exc))
                    self._session_changed()
                raise
            self.master_state.scan_succeeded(slaves)
            try:
                refreshed = list(self._submit("read_states"))
            except BaseException as exc:
                # Discovery remains valid even when a follow-up state read has
                # a transient transport failure. Keep the scanned topology and
                # surface the read failure in the same published snapshot.
                self.master_state.state_read_failed(str(exc))
            else:
                if self.master_state.states_updated(refreshed):
                    self.write_plans.clear()
                slaves = refreshed
            self._session_changed()
            return slaves
        if method == "read_states":
            try:
                slaves = list(self._submit("read_states", **({"refresh_eeprom": True} if params.get("refresh_eeprom") else {})))
            except BaseException as exc:
                self.master_state.state_read_failed(str(exc))
                self._publish_snapshot()
                raise
            if self.master_state.states_updated(slaves):
                self.write_plans.clear()
            self._publish_snapshot()
            return slaves
        if method == "request_state":
            raw_position = params.get("position")
            position = None if raw_position in {None, 0} else int(raw_position)
            state = EtherCatState(int(params["state"]))
            if self.cycle_running:
                self._dispatch_serial("stop_cycle", {})
            current = min((slave.state for slave in self.slaves), default=state)
            downgrade = {
                EtherCatState.INIT: {EtherCatState.OP: (EtherCatState.SAFE_OP, EtherCatState.PRE_OP), EtherCatState.SAFE_OP: (EtherCatState.PRE_OP,)},
                EtherCatState.PRE_OP: {EtherCatState.OP: (EtherCatState.SAFE_OP,)},
            }
            for intermediate in downgrade.get(state, {}).get(current, ()):
                self._submit("request_state", position, intermediate, 2_000_000)
            if state is EtherCatState.OP:
                self._dispatch_serial("start_cycle", {"period_ms": 5, "position": position})
                return list(self.slaves)
            try:
                slaves = list(self._submit("request_state", position, state, 2_000_000))
            except BaseException as exc:
                try:
                    current = list(self._submit("read_states"))
                except BaseException:
                    self.master_state.state_read_failed(str(exc))
                else:
                    if self.master_state.states_updated(current):
                        self.write_plans.clear()
                self._publish_snapshot()
                raise
            if state in {EtherCatState.SAFE_OP, EtherCatState.OP}:
                self.master_state.pdo_configured(slaves)
            else:
                self.master_state.states_updated(slaves)
            self._publish_snapshot()
            return slaves
        if method in {"reconfig", "recover"}:
            if self.cycle_running:
                raise RuntimeError("周期通信运行时不能重配置或恢复从站，请先停止周期通信")
            position = int(params["position"])
            try:
                succeeded = bool(self._submit(method, position, 2_000_000))
                if not succeeded:
                    raise RuntimeError(f"从站 {position} {method} 未成功")
                slaves = list(self._submit("read_states"))
                recovered = next((item for item in slaves if item.position == position), None)
                if recovered is None:
                    raise RuntimeError(f"从站 {position} {method} 返回成功，但状态复核时未发现该从站")
                if method == "recover" and (
                    recovered.state is EtherCatState.NONE or int(recovered.al_status) != 0
                ):
                    raise RuntimeError(
                        f"从站 {position} recover 返回成功，但状态复核未通过："
                        f"{recovered.state.name}，AL 状态码 0x{int(recovered.al_status):04X}"
                    )
            except BaseException as exc:
                if not self._worker_stalled:
                    self.master_state.topology_changed((), str(exc))
                    self._session_changed()
                raise
            self.master_state.topology_changed(slaves)
            self._session_changed()
            return {"succeeded": True, "slaves": slaves}
        if method == "sdo_read":
            data = self._submit(
                "sdo_read",
                int(params["position"]),
                int(params["index"]),
                int(params["subindex"]),
            )
            return {"data": data}
        if method == "sdo_write":
            data = bytes.fromhex(str(params["data"]))
            position = int(params["position"])
            index = int(params["index"])
            subindex = int(params["subindex"])
            self._submit("sdo_write", position, index, subindex, data)
            readback = self._submit("sdo_read", position, index, subindex)
            return {"data": data, "readback": readback, "verified": readback == data}
        if method == "object_dictionary":
            return self._submit("read_object_dictionary", int(params["position"]))
        if method == "pdo_mapping":
            position = int(params["position"])
            rx = self._submit("read_pdo_mapping", position, PdoDirection.RX)
            tx = self._submit("read_pdo_mapping", position, PdoDirection.TX)
            return {"rx": rx, "tx": tx}
        if method == "set_output":
            data = bytes.fromhex(str(params["data"]))
            self._submit("set_output", int(params["position"]), data)
            return {"applied": True, "data": data}
        if method == "start_cycle":
            if self.cycle_running:
                raise RuntimeError("周期通信已经运行")
            try:
                result = self._submit(
                    "__start_cycle__",
                    float(params["period_ms"]),
                    2000,
                    5,
                    priority=Priority.CONTROL,
                    timeout=10,
                    position=params.get("position") or None,
                )
            except BaseException as exc:
                if self._worker_stalled:
                    raise
                try:
                    slaves = list(self._submit("read_states"))
                except BaseException:
                    self.master_state.state_read_failed(str(exc))
                else:
                    self.master_state.cycle_faulted(str(exc), slaves)
                self._publish_snapshot()
                raise
            self.master_state.cycle_started(result[3])
            self._publish_snapshot()
            return {"running": True}
        if method == "stop_cycle":
            try:
                result = self._submit("__stop_cycle__", priority=Priority.CONTROL, timeout=10)
            except BaseException as exc:
                self._fault_worker(f"周期通信无法安全停止：{exc}")
                raise
            self.master_state.cycle_stopped(result or self.slaves)
            self._publish_snapshot()
            return {"running": False, "slaves": self.slaves}
        if method == "register_catalog":
            position = params.get("position")
            registry = self.profiles
            chip_model = self._register_profile(params, int(position), registry) if position is not None else "Generic ESC"
            return registry.catalog_summary(chip_model)
        if method == "register_definition":
            definition = self._register_definition(params)
            if definition is None:
                raise ValueError("Register definition requires position and definition_id")
            return definition
        if method == "register_read":
            definition = self._register_definition(params)
            if definition is not None:
                self._require_master_read(definition)
                self._require_definition_range(params, definition)
            result = self._submit(
                lambda backend: RegisterService(backend).read(
                    int(params["position"]),
                    int(params["address"]),
                    int(params["size"]),
                    address_space=str(definition["address_space"]) if definition is not None else "esc_core",
                    master_access_allowed=bool(definition["master_access_allowed"])
                    if definition is not None
                    else True,
                )
            )
            return result
        if method == "register_watch":
            requests = []
            for item in params["requests"]:
                definition = self._register_definition(item, default_position=params.get("position"))
                if definition is not None:
                    self._require_master_read(definition)
                    self._require_definition_range(item, definition)
                requests.append((int(item["address"]), int(item["size"])))
            return self._submit(
                lambda backend: list(
                    RegisterService(backend).read_merged(tuple(requests), int(params["position"])).values()
                ),
                priority=Priority.WATCH,
            )
        if method == "register_prepare_write":
            known_register = bool(params.get("known_register", False))
            data = bytes.fromhex(str(params["data"]))
            expected_width = None
            expected_semantics = None
            definition_id = None
            address_space = "esc_core"
            master_access_allowed = True
            direct_write_allowed = True
            if known_register:
                definition = self._register_definition(params)
                if definition is None:
                    raise ValueError("Known register must include a definition_id from the selected slave profile")
                self._require_definition_range(params, definition)
                self._require_master_read(definition)
                expected_width = int(definition["width"])
                if len(data) != expected_width:
                    raise ValueError(f"Known register write must be exactly {expected_width} bytes")
                try:
                    expected_semantics = AccessSemantics(str(definition["access"]))
                except ValueError as exc:
                    raise PermissionError("Mixed-permission register requires a dedicated safe operation") from exc
                definition_id = str(definition["definition_id"])
                address_space = str(definition["address_space"])
                master_access_allowed = bool(definition["master_access_allowed"])
                direct_write_allowed = bool(definition["direct_write_allowed"])
            else:
                expected_width = int(params["size"])
                if not 1 <= expected_width <= 256:
                    raise ValueError("Raw register width must be between 1 and 256 bytes")
                if len(data) != expected_width:
                    raise ValueError(f"Raw register write must be exactly {expected_width} bytes")
            semantics = AccessSemantics(str(params["semantics"]))
            plan = self._submit(
                lambda backend: RegisterService(backend).prepare_write(
                    int(params["position"]),
                    int(params["address"]),
                    data,
                    semantics,
                    known_register,
                    expected_width=expected_width,
                    expected_semantics=expected_semantics,
                    definition_id=definition_id,
                    address_space=address_space,
                    master_access_allowed=master_access_allowed,
                    direct_write_allowed=direct_write_allowed,
                )
            )
            plan_id = uuid.uuid4().hex
            self.write_plans[plan_id] = _StoredRegisterPlan(
                plan,
                self.session_id,
                self._slave_signature(plan.position),
                time.monotonic(),
            )
            return {"plan_id": plan_id, "plan": plan, "expires_in_seconds": 60}
        if method == "register_execute_write":
            stored = self.write_plans.pop(str(params["plan_id"]), None)
            if stored is None:
                raise RuntimeError("寄存器写入计划不存在、已执行或已因总线会话变化而失效")
            if time.monotonic() - stored.created_at > 60:
                raise RuntimeError("寄存器写入确认已过期，请重新读取并确认")
            if stored.session_id != self.session_id:
                raise RuntimeError("总线会话已变化，拒绝执行旧寄存器写入计划")
            if stored.slave_signature != self._slave_signature(stored.plan.position):
                raise RuntimeError("目标从站身份或配置地址已变化，拒绝执行旧寄存器写入计划")
            plan = stored.plan
            details = {
                "position": plan.position,
                "address": f"0x{plan.address:04X}",
                "semantics": plan.semantics.value,
                "current": plan.current.hex(" ").upper(),
                "target": plan.target.hex(" ").upper(),
                "changed_mask": plan.changed_mask.hex(" ").upper(),
                "known_register": plan.known_register,
                "definition_id": plan.definition_id,
            }
            try:
                result = self._submit(lambda backend: RegisterService(backend).execute_write(plan))
            except BaseException as exc:
                self.audit.record("register_write", details, outcome="failed", error=str(exc))
                raise
            if result.verified is False:
                self.audit.record("register_write", details, outcome="failed", error=result.conclusion)
                raise RuntimeError(result.conclusion)
            self.audit.record("register_write", details, outcome="succeeded")
            return result
        if method == "register_reset":
            position = int(params["position"])
            registry = self.profiles
            profile_name = self._register_profile(params, position, registry)
            profile = registry.get(profile_name)
            if not profile.reset_supported:
                raise RuntimeError(f"{profile_name} 未声明支持 ESC RES 复位序列")
            result = self._audited(
                "register_reset_ecat",
                {"position": position, "address": "0x0040", "sequence": "52 45 53"},
                lambda: self._submit(lambda backend: ResetService(backend).reset_ecat(position)),
            )
            self.master_state.topology_changed((), "ESC 已复位，需要重新扫描总线")
            self._session_changed()
            return result
        if method == "eeprom_read":
            if self.cycle_running:
                raise RuntimeError("完整读取 EEPROM 前必须先安全停止周期通信")
            self.cancel.clear()
            raw = self._submit(
                lambda backend: EepromService(backend).read_full(
                    int(params["position"]), progress=self._progress, cancel=self.cancel.is_set
                ),
                timeout=300,
            )
            response: dict[str, Any] = {
                "data": raw,
                "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "read_at": datetime.now(UTC).isoformat(),
            }
            try:
                parsed = SiiParser().parse(raw)
            except Exception as exc:
                response.update({"sii_valid": False, "sii_error": str(exc)})
            else:
                response.update(
                    {
                        "sii_valid": True,
                        "identity": {
                            "vendor_id": parsed.vendor_id,
                            "product_code": parsed.product_code,
                            "revision": parsed.revision,
                            "serial_number": parsed.serial_number,
                        },
                        "category_count": len(parsed.categories),
                        "categories": [category.kind for category in parsed.categories],
                        "end_offset": parsed.end_offset,
                    }
                )
            target_id = str(params.get("target_id") or "")
            if target_id and target_id in self.targets:
                response["comparison"] = compare_images(self.targets[target_id][0], raw)
            return response
        if method == "eeprom_capacity":
            size = self._submit(lambda backend: EepromService(backend).read_capacity(int(params["position"])))
            return {"size": size}
        if method == "eeprom_header":
            position = int(params["position"])
            header, size = self._submit(
                lambda backend: (
                    EepromService(backend).read_configuration_header(position),
                    EepromService(backend).read_capacity(position),
                )
            )
            return {
                "header": header,
                "config_data": header[:10],
                "crc_valid": crc8(header) == 0,
                "size": size,
            }
        if method == "eeprom_backup":
            if self.cycle_running:
                raise RuntimeError("备份 EEPROM 前必须先安全停止周期通信")
            self.cancel.clear()
            position = int(params["position"])
            return self._submit(
                lambda backend: EepromService(backend).backup(
                    position,
                    Path(params["directory"]),
                    self._slave(position),
                    progress=self._progress,
                    cancel=self.cancel.is_set,
                ),
                timeout=300,
            )
        if method == "esi_library_list":
            library = Path(params["directory"]).resolve() if params.get("directory") else _default_esi_library_path()
            if library is None or not library.is_dir():
                return {"directory": str(library or ""), "entries": [], "errors": []}
            entries: list[dict[str, Any]] = []
            errors: list[dict[str, str]] = []
            for source in sorted(library.glob("*.xml"), key=lambda item: item.name.casefold()):
                try:
                    document = EsiParser().parse(source)
                except BaseException as exc:
                    errors.append({"path": str(source), "error": str(exc)})
                    continue
                for device in document.devices:
                    entries.append(
                        {
                            "path": str(document.path),
                            "sha256": document.sha256,
                            "vendor_id": document.vendor_id,
                            "vendor_name": document.vendor_name,
                            "ordinal": device.ordinal,
                            "device_name": device.name,
                            "type_name": device.type_name,
                            "product_code": device.product_code,
                            "revision": device.revision,
                            "byte_size": device.byte_size,
                            "config_data": device.config_data,
                        }
                    )
            return {"directory": str(library), "entries": entries, "errors": errors}
        if method == "esi_load":
            document = EsiParser().parse(Path(params["path"]))
            document_id = uuid.uuid4().hex
            self.documents[document_id] = document
            return {
                "document_id": document_id,
                "path": document.path,
                "sha256": document.sha256,
                "vendor_id": document.vendor_id,
                "vendor_name": document.vendor_name,
                "devices": document.devices,
            }
        if method == "sii_generate":
            document = self.documents[str(params["document_id"])]
            ordinal = int(params["ordinal"])
            device = document.devices[ordinal]
            original_config_data = device.config_data
            if params.get("config_data") is not None:
                try:
                    config_data = bytes.fromhex(str(params["config_data"]))
                except ValueError as exc:
                    raise ValueError("ConfigData 必须是十六进制字节") from exc
                if len(config_data) != 10:
                    raise ValueError("ConfigData 必须正好包含 10 个字节")
                device = dataclasses.replace(device, config_data=config_data)
            report: SiiGenerationReport = SiiGenerator().generate(device)
            target_id = uuid.uuid4().hex
            self.targets[target_id] = (report.image, device)
            parsed = SiiParser().parse(report.image)
            category_names = {
                0x000A: "Strings",
                0x001E: "General",
                0x0028: "FMMU",
                0x0029: "SyncManager",
                0x0032: "TxPDO",
                0x0033: "RxPDO",
                0x003C: "Distributed Clocks",
            }
            layout = [
                {
                    "kind": None,
                    "name": "Fixed SII area",
                    "offset": 0,
                    "length": SiiParser.CATEGORY_START,
                    "content": report.image[:32].hex(" ").upper(),
                },
                *(
                    {
                        "kind": category.kind,
                        "name": category_names.get(
                            category.kind,
                            "Vendor-specific" if category.kind >= 0x8000 else "Unknown",
                        ),
                        "offset": category.offset,
                        "length": 4 + len(category.payload),
                        "content": category.payload[:32].hex(" ").upper(),
                    }
                    for category in parsed.categories
                ),
                {
                    "kind": 0xFFFF,
                    "name": "End marker",
                    "offset": parsed.end_offset,
                    "length": 2,
                    "content": "FF FF",
                },
            ]
            return {
                "target_id": target_id,
                "size": len(report.image),
                "sha256": hashlib.sha256(report.image).hexdigest(),
                "supported": report.supported,
                "omitted": report.omitted,
                "layout": layout,
                "device": device,
                "original_config_data": original_config_data,
                "effective_config_data": device.config_data,
            }
        if method == "eeprom_flash":
            position = int(params["position"])
            slave = self._slave(position)
            if self.cycle_running:
                raise RuntimeError("必须先安全停止周期通信")
            target, device = self.targets[str(params["target_id"])]
            self.cancel.clear()
            details = {
                "position": position,
                "initial_state": slave.state.name,
                "target_sha256": hashlib.sha256(target).hexdigest(),
                "size": len(target),
                "vendor_id": device.vendor_id,
                "product_code": device.product_code,
                "revision": device.revision,
            }
            try:
                _, state_changed = self._ensure_slave_init(position, "eeprom-flash")
                details["auto_init"] = state_changed
                result = self._submit(
                    lambda backend: EepromService(
                        backend,
                        stability_wait_s=self.stability_wait_s,
                        rediscovery_timeout_s=self.rediscovery_timeout_s,
                        rediscovery_poll_s=self.rediscovery_poll_s,
                    ).flash(
                        position,
                        target,
                        device,
                        auto_reset=bool(params.get("auto_reset", True)),
                        progress=self._progress,
                        cancel=self.cancel.is_set,
                    ),
                    timeout=900,
                )
            except BaseException as exc:
                self.audit.record("eeprom_flash", details, outcome="failed", error=str(exc))
                raise
            details.update(
                {
                    "image_success": result.image_success,
                    "rediscovered": result.rediscovered,
                    "reload_verified": result.reload_verified,
                }
            )
            self.audit.record(
                "eeprom_flash",
                details,
                outcome="succeeded" if result.image_success else "failed",
                error=None if result.image_success else result.image_verification,
            )
            if result.reset_sequence is not None:
                slaves: list[Any] = []
                if result.rediscovered:
                    try:
                        slaves = list(self._submit("read_states"))
                    except Exception:
                        slaves = []
                self.master_state.topology_changed(
                    slaves,
                    None if slaves else "EEPROM 复位后未重新发现从站，请重新扫描总线",
                )
                self._session_changed()
            return {"success": result.image_success, "result": result, "slaves": self.slaves}
        if method == "eeprom_restore":
            position = int(params["position"])
            slave = self._slave(position)
            if self.cycle_running:
                raise RuntimeError("必须先安全停止周期通信")
            self.cancel.clear()
            path = Path(params["path"])
            details = {"position": position, "path": str(path), "initial_state": slave.state.name}
            try:
                _, state_changed = self._ensure_slave_init(position, "eeprom-restore")
                details["auto_init"] = state_changed
                result = self._submit(
                    lambda backend: EepromService(
                        backend,
                        stability_wait_s=self.stability_wait_s,
                        rediscovery_timeout_s=self.rediscovery_timeout_s,
                        rediscovery_poll_s=self.rediscovery_poll_s,
                    ).restore(
                        position,
                        path,
                        auto_reset=bool(params.get("auto_reset", True)),
                        progress=self._progress,
                        cancel=self.cancel.is_set,
                    ),
                    timeout=900,
                )
            except BaseException as exc:
                self.audit.record("eeprom_restore", details, outcome="failed", error=str(exc))
                raise
            details.update(
                {
                    "image_success": result.image_success,
                    "rediscovered": result.rediscovered,
                    "reload_verified": result.reload_verified,
                }
            )
            self.audit.record(
                "eeprom_restore",
                details,
                outcome="succeeded" if result.image_success else "failed",
                error=None if result.image_success else result.image_verification,
            )
            if result.reset_sequence is not None:
                slaves = []
                if result.rediscovered:
                    try:
                        slaves = list(self._submit("read_states"))
                    except Exception:
                        slaves = []
                self.master_state.topology_changed(
                    slaves,
                    None if slaves else "EEPROM 复位后未重新发现从站，请重新扫描总线",
                )
                self._session_changed()
            return {"success": result.image_success, "result": result, "slaves": self.slaves}
        raise ValueError(f"Unknown bridge method: {method}")

    def shutdown(self) -> None:
        if self._stopped.is_set():
            return
        self._stopped.set()
        with self._worker_lock:
            self.worker.shutdown()


def _handle_request(
    runtime: BridgeRuntime,
    writer: JsonWriter,
    request: dict[str, Any],
    request_slots: threading.BoundedSemaphore | None = None,
) -> None:
    request_id = int(request.get("id", 0))
    method = str(request.get("method") or "")
    spec: CommandSpec | None = None
    try:
        try:
            spec = runtime.registry.require(method)
            if int(request.get("protocol", 0)) != runtime.registry.protocol_version:
                raise ValueError("bridge protocol version mismatch")
            request_session = request.get("session_id")
            if spec.lane == "hardware" and request_session is not None:
                if int(request_session) != runtime.session_id:
                    raise RuntimeError("request belongs to an expired EtherCAT session")
            result = runtime.dispatch(
                method,
                dict(request.get("params") or {}),
                deadline_at_ms=int(request["deadline_at_ms"])
                if request.get("deadline_at_ms") is not None
                else None,
            )
        except BaseException as exc:
            snapshot = runtime.snapshot()
            writer.send(
                {
                    "type": "response",
                    "id": request_id,
                    "ok": False,
                    "error": _structured_error(
                        exc,
                        request_id=request_id,
                        method=method,
                        spec=spec,
                        session_id=snapshot["session_id"],
                        snapshot=snapshot,
                    ),
                }
            )
        else:
            snapshot = runtime.snapshot()
            writer.send(
                {
                    "type": "response",
                    "id": request_id,
                    "ok": True,
                    "result": result,
                    "session_id": snapshot["session_id"],
                    "snapshot": snapshot,
                }
            )
    finally:
        if request_slots is not None:
            request_slots.release()


def _open_pipe(path: str, *, mode: str, timeout_s: float = 10.0) -> Any:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return open(path, mode, buffering=0)
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _heartbeat(runtime: BridgeRuntime, writer: JsonWriter, stopped: threading.Event) -> None:
    while not stopped.wait(1.0):
        writer.event(
            "heartbeat",
            {
                "session_id": runtime.session_id,
                "revision": runtime.master_state.snapshot().revision,
                "worker_state": runtime.worker.state.value,
                "queue_depth": runtime.worker.queue_depth,
            },
        )


def main() -> int:
    request_pipe_name = os.environ.get("BENCHCAT_REQUEST_PIPE")
    response_pipe_name = os.environ.get("BENCHCAT_RESPONSE_PIPE")
    if not request_pipe_name or not response_pipe_name:
        print(
            "BENCHCAT_REQUEST_PIPE and BENCHCAT_RESPONSE_PIPE are required",
            file=sys.stderr,
            flush=True,
        )
        return 2
    registry = load_command_registry()
    request_stream = _open_pipe(request_pipe_name, mode="rb")
    response_stream = _open_pipe(response_pipe_name, mode="wb")
    reader = IncrementalFrameReader(registry.max_frame_bytes)
    writer = JsonWriter(response_stream, registry.max_frame_bytes)
    mode = BackendMode(os.environ.get("BENCHCAT_MODE", BackendMode.REAL.value))
    runtime = BridgeRuntime(writer, mode, audit_path=default_audit_path())
    stopped = threading.Event()
    heartbeat = threading.Thread(target=_heartbeat, args=(runtime, writer, stopped), daemon=True)
    heartbeat.start()
    writer.event(
        "ready",
        {"mode": runtime.mode.value, "protocol_version": registry.protocol_version},
    )
    pools = {
        "control": ThreadPoolExecutor(max_workers=2, thread_name_prefix="Bridge control"),
        "metadata": ThreadPoolExecutor(max_workers=2, thread_name_prefix="Bridge metadata"),
        # Hardware dispatches share _command_lock and therefore remain strictly
        # serialized before reaching the sole Master-owning Worker.
        "hardware": ThreadPoolExecutor(max_workers=4, thread_name_prefix="Bridge hardware"),
    }
    slots = {
        "control": threading.BoundedSemaphore(4),
        "metadata": threading.BoundedSemaphore(registry.metadata_queue),
        "hardware": threading.BoundedSemaphore(registry.hardware_queue),
    }
    try:
        while True:
            try:
                request = reader.read(request_stream, stopped=lambda: writer.failed)
            except (FrameError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                writer.event("protocol_error", str(exc))
                continue
            except EOFError:
                break
            method = str(request.get("method") or "")
            try:
                spec = registry.require(method)
            except ValueError as exc:
                snapshot = runtime.snapshot()
                writer.send(
                    {
                        "type": "response",
                        "id": int(request.get("id", 0)),
                        "ok": False,
                        "error": _structured_error(
                            exc,
                            request_id=int(request.get("id", 0)),
                            method=method,
                            spec=None,
                            session_id=snapshot["session_id"],
                            snapshot=snapshot,
                        ),
                    }
                )
                continue
            lane_slots = slots[spec.lane]
            if not lane_slots.acquire(blocking=False):
                error = RuntimeError(f"{spec.lane} queue is full")
                snapshot = runtime.snapshot()
                writer.send(
                    {
                        "type": "response",
                        "id": int(request.get("id", 0)),
                        "ok": False,
                        "error": _structured_error(
                            error,
                            request_id=int(request.get("id", 0)),
                            method=method,
                            spec=spec,
                            session_id=snapshot["session_id"],
                            snapshot=snapshot,
                        ),
                    }
                )
                continue
            writer.send({"type": "accepted", "id": int(request.get("id", 0)), "lane": spec.lane})
            if method == "shutdown":
                _handle_request(runtime, writer, request, lane_slots)
                break
            pools[spec.lane].submit(_handle_request, runtime, writer, request, lane_slots)
    finally:
        stopped.set()
        runtime.shutdown()
        for pool in pools.values():
            pool.shutdown(wait=False, cancel_futures=True)
        writer.close()
        request_stream.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
