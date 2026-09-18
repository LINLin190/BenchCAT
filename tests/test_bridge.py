from __future__ import annotations

import io
import json
import threading
import time
from dataclasses import replace
from typing import Any

import pytest

from ethercat_debug_tool.bridge import (
    BridgeRuntime,
    EepromExclusiveError,
    _handle_request,
    _json_value,
    _ordered_adapters,
    _scan_adapter,
    _structured_error,
)
from ethercat_debug_tool.command_registry import load_command_registry
from ethercat_debug_tool.framing import FrameError, read_frame, write_frame
from ethercat_debug_tool.infrastructure.audit import AuditLogger
from ethercat_debug_tool.models import AdapterInfo, BackendMode, EtherCatState
from ethercat_debug_tool.worker.ethercat_worker import WorkerEvent


class RecordingWriter:
    def __init__(self) -> None:
        self.events: list[tuple[str, Any]] = []
        self.event_sessions: list[int | None] = []
        self.messages: list[dict[str, Any]] = []

    def event(self, kind: str, payload: Any, session_id: int | None = None) -> None:
        self.events.append((kind, payload))
        self.event_sessions.append(session_id)

    def send(self, message: dict[str, Any]) -> None:
        self.messages.append(_json_value(message))


class MultiAdapterBackend:
    def __init__(self, slave_adapter: str | None) -> None:
        self.connected = False
        self.current = ""
        self.slave_adapter = slave_adapter
        self.calls: list[str] = []

    def enumerate_adapters(self) -> list[AdapterInfo]:
        return [
            AdapterInfo("adapter-a", "Adapter A"),
            AdapterInfo("adapter-b", "Adapter B"),
            AdapterInfo("adapter-c", "Adapter C"),
        ]

    def connect(self, adapter: str) -> None:
        self.calls.append(f"connect:{adapter}")
        self.current = adapter
        self.connected = True

    def scan(self) -> list[str]:
        self.calls.append(f"scan:{self.current}")
        return ["slave"] if self.current == self.slave_adapter else []

    def disconnect(self) -> None:
        self.calls.append(f"disconnect:{self.current}")
        self.connected = False
        self.current = ""


def test_auto_scan_prioritizes_preferred_adapter_and_stops_on_first_slave() -> None:
    backend = MultiAdapterBackend("adapter-c")

    attempts = []
    selected = ""
    slaves: list[str] = []
    for item in _ordered_adapters(backend.enumerate_adapters(), "adapter-b"):
        attempt, slaves = _scan_adapter(backend, item.name)
        attempts.append(attempt)
        if slaves:
            selected = item.name
            break

    assert selected == "adapter-c"
    assert slaves == ["slave"]
    assert all(attempt["elapsed_ms"] >= 0 for attempt in attempts)
    assert backend.calls == [
        "connect:adapter-b",
        "scan:adapter-b",
        "disconnect:adapter-b",
        "connect:adapter-a",
        "scan:adapter-a",
        "disconnect:adapter-a",
        "connect:adapter-c",
        "scan:adapter-c",
    ]


def test_auto_scan_prioritizes_physical_ethernet_before_virtual_adapters() -> None:
    class OrderedBackend(MultiAdapterBackend):
        def enumerate_adapters(self) -> list[AdapterInfo]:
            return [
                AdapterInfo("wifi", "Qualcomm Wireless Adapter"),
                AdapterInfo("ethernet", "Realtek PCIe GbE Family Controller"),
                AdapterInfo("vm", "VMware Virtual Ethernet Adapter"),
            ]

    backend = OrderedBackend("ethernet")

    ordered = _ordered_adapters(backend.enumerate_adapters())
    attempt, slaves = _scan_adapter(backend, ordered[0].name)

    assert ordered[0].name == "ethernet"
    assert attempt["slave_count"] == 1
    assert slaves == ["slave"]
    assert backend.calls == ["connect:ethernet", "scan:ethernet"]


def test_auto_scan_restores_preferred_selection_and_disconnects_when_empty() -> None:
    backend = MultiAdapterBackend(None)

    attempts = [
        _scan_adapter(backend, item.name)[0]
        for item in _ordered_adapters(backend.enumerate_adapters(), "adapter-b")
    ]

    assert attempts[0]["adapter"] == "adapter-b"
    assert all(attempt["slave_count"] == 0 for attempt in attempts)
    assert backend.connected is False


def test_auto_scan_records_adapter_timeout_before_faulting_worker(monkeypatch, tmp_path) -> None:
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")

    def submit(operation, *args, **kwargs):
        if operation == "enumerate_adapters":
            return [AdapterInfo("ethernet", "Realtek PCIe GbE Family Controller")]
        raise TimeoutError("simulated native timeout")

    monkeypatch.setattr(runtime, "_submit", submit)
    try:
        with pytest.raises(TimeoutError, match="Realtek PCIe GbE Family Controller"):
            runtime.dispatch("auto_scan", {})
        timeout_events = [payload for kind, payload in writer.events if kind == "auto_scan_attempt"]
        assert timeout_events[-1]["adapter"] == "ethernet"
        assert timeout_events[-1]["timed_out"] is True
        assert timeout_events[-1]["state"] == "timed_out"
    finally:
        runtime.shutdown()


def test_bridge_demo_core_commands(tmp_path) -> None:
    writer = RecordingWriter()
    audit_path = tmp_path / "audit.jsonl"
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=audit_path)  # type: ignore[arg-type]
    try:
        automatic = runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        assert automatic["adapters"][0].name == "demo0"
        assert automatic["selected_adapter"] == "demo0"
        assert automatic["connected"] is True
        slaves = automatic["slaves"]
        assert len(slaves) == 3
        assert runtime.dispatch("status", {})["connected"] is True

        sdo = runtime.dispatch("sdo_read", {"position": 1, "index": 0x1000, "subindex": 0})
        assert sdo["data"] == bytes.fromhex("92 01 02 00")

        register = runtime.dispatch("register_read", {"position": 1, "address": 0x0130, "size": 2})
        assert register.data == bytes.fromhex("02 00")

        prepared = runtime.dispatch(
            "register_prepare_write",
            {
                "position": 1,
                "address": 0x0010,
                "data": "34 12",
                "semantics": "RW",
                "known_register": True,
            },
        )
        assert prepared["expires_in_seconds"] == 60
        written = runtime.dispatch("register_execute_write", {"plan_id": prepared["plan_id"]})
        assert written.verified is True
        with pytest.raises(ValueError, match="exactly 4 bytes"):
            runtime.dispatch(
                "register_prepare_write",
                {
                    "position": 1,
                    "address": 0x0100,
                    "data": "12",
                    "semantics": "RW",
                    "known_register": True,
                },
            )

        with pytest.raises(ValueError, match="exactly 2 bytes"):
            runtime.dispatch(
                "register_prepare_write",
                {
                    "position": 1,
                    "address": 0x0200,
                    "size": 2,
                    "data": "12",
                    "semantics": "RW",
                    "known_register": False,
                },
            )

        assert runtime.dispatch("eeprom_capacity", {"position": 1}) == {"size": 2048}

        backup = runtime.dispatch("eeprom_backup", {"position": 1, "directory": str(tmp_path)})
        assert backup.binary_path.suffix == ".bin"
        assert backup.binary_path.exists()
        assert list(tmp_path.glob("*.json")) == []

        serializable = _json_value(runtime.dispatch("status", {}))
        assert serializable["mode"] == "demo"
        assert serializable["slaves"][0]["state"] == 2
        audit = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
        assert audit[-1]["level"] == "AUDIT"
        assert audit[-1]["action"] == "register_write"
        assert audit[-1]["outcome"] == "succeeded"
    finally:
        runtime.shutdown()


def test_command_response_atomically_carries_new_session_and_snapshot(tmp_path) -> None:
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")
    protocol = load_command_registry().protocol_version
    try:
        _handle_request(
            runtime,
            writer,  # type: ignore[arg-type]
            {
                "protocol": protocol,
                "id": 1,
                "method": "connect",
                "params": {"adapter": "demo0"},
                "session_id": 0,
            },
        )
        connected = writer.messages[-1]
        assert connected["ok"] is True
        assert connected["session_id"] == 1
        assert connected["snapshot"]["session_id"] == 1
        assert connected["snapshot"]["phase"] == "adapter_open"

        _handle_request(
            runtime,
            writer,  # type: ignore[arg-type]
            {"protocol": protocol, "id": 2, "method": "scan", "params": {}, "session_id": 1},
        )
        scanned = writer.messages[-1]
        assert scanned["ok"] is True
        assert scanned["session_id"] == 2
        assert scanned["snapshot"]["phase"] == "bus_scanned"
        assert len(scanned["snapshot"]["slaves"]) == 3

        _handle_request(
            runtime,
            writer,  # type: ignore[arg-type]
            {"protocol": protocol, "id": 3, "method": "read_states", "params": {}, "session_id": 1},
        )
        stale = writer.messages[-1]
        assert stale["ok"] is False
        assert stale["error"]["code"] == "SESSION_CHANGED"
        assert stale["error"]["snapshot"]["session_id"] == 2
    finally:
        runtime.shutdown()


def test_disconnect_failure_still_converges_to_disconnected_snapshot(tmp_path) -> None:
    runtime = BridgeRuntime(
        RecordingWriter(), BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl"
    )  # type: ignore[arg-type]
    try:
        runtime.dispatch("connect", {"adapter": "demo0"})
        backend = runtime.worker._backend
        assert backend is not None
        original_disconnect = backend.disconnect

        def broken_disconnect() -> None:
            original_disconnect()
            raise RuntimeError("close failed")

        backend.disconnect = broken_disconnect  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="close failed"):
            runtime.dispatch("disconnect", {})

        snapshot = runtime.snapshot()
        assert snapshot["phase"] == "disconnected"
        assert snapshot["connected"] is False
        assert snapshot["slaves"] == []
        assert snapshot["last_error"] == "close failed"
    finally:
        runtime.shutdown()


def test_failed_rescan_invalidates_old_slave_snapshot(tmp_path) -> None:
    runtime = BridgeRuntime(
        RecordingWriter(), BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl"
    )  # type: ignore[arg-type]
    try:
        runtime.dispatch("connect", {"adapter": "demo0"})
        runtime.dispatch("scan", {})
        previous_session = runtime.session_id
        backend = runtime.worker._backend
        assert backend is not None

        def failed_scan() -> list[Any]:
            raise RuntimeError("link lost")

        backend.scan = failed_scan  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="link lost"):
            runtime.dispatch("scan", {})

        snapshot = runtime.snapshot()
        assert snapshot["phase"] == "adapter_open"
        assert snapshot["connected"] is True
        assert snapshot["slaves"] == []
        assert snapshot["session_id"] == previous_session + 1
    finally:
        runtime.shutdown()


def test_worker_event_from_expired_session_is_not_forwarded_or_applied(tmp_path) -> None:
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")
    try:
        runtime.dispatch("connect", {"adapter": "demo0"})
        stale_session = runtime.session_id
        runtime.dispatch("scan", {})
        writer.events.clear()
        writer.event_sessions.clear()

        runtime.worker._events.put(WorkerEvent("slaves_changed", (), stale_session))
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and runtime.worker._events.qsize():
            time.sleep(0.01)

        snapshot = runtime.snapshot()
        assert snapshot["phase"] == "bus_scanned"
        assert len(snapshot["slaves"]) == 3
        assert not any(kind == "slaves_changed" for kind, _payload in writer.events)
    finally:
        runtime.shutdown()


def test_failed_safe_cycle_stop_faults_generation_instead_of_claiming_disconnect(tmp_path) -> None:
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")
    try:
        runtime.dispatch("connect", {"adapter": "demo0"})
        runtime.dispatch("scan", {})
        runtime.dispatch("start_cycle", {"period_ms": 10})
        backend = runtime.worker._backend
        assert backend is not None
        original_request_state = backend.request_state

        def failed_safe_state(position: int | None, state: Any, timeout_us: int) -> list[Any]:
            if state.value == 4:
                raise RuntimeError("SAFE-OP rejected")
            return original_request_state(position, state, timeout_us)

        backend.request_state = failed_safe_state  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="SAFE-OP rejected"):
            runtime.dispatch("stop_cycle", {})

        snapshot = runtime.snapshot()
        assert snapshot["phase"] == "faulted"
        assert snapshot["connected"] is False
        assert snapshot["cycle_running"] is False
        assert any(kind == "worker_stalled" for kind, _payload in writer.events)
    finally:
        runtime.shutdown()


def test_state_read_failure_during_cycle_does_not_claim_cycle_stopped(tmp_path) -> None:
    runtime = BridgeRuntime(
        RecordingWriter(), BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl"
    )  # type: ignore[arg-type]
    try:
        runtime.dispatch("connect", {"adapter": "demo0"})
        runtime.dispatch("scan", {})
        runtime.dispatch("start_cycle", {"period_ms": 10})
        backend = runtime.worker._backend
        assert backend is not None
        original_read_states = backend.read_states

        def failed_read_states() -> list[Any]:
            raise RuntimeError("temporary state read failure")

        backend.read_states = failed_read_states  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="temporary state read failure"):
            runtime.dispatch("read_states", {})

        snapshot = runtime.snapshot()
        assert snapshot["phase"] == "cyclic"
        assert snapshot["cycle_running"] is True
        assert snapshot["last_error"] == "temporary state read failure"
        backend.read_states = original_read_states  # type: ignore[method-assign]
        runtime.dispatch("stop_cycle", {})
    finally:
        runtime.shutdown()


def test_exception_event_payload_is_json_serializable() -> None:
    assert json.dumps(_json_value({"error": RuntimeError("link failed")})) == '{"error": "link failed"}'


def test_register_write_plan_is_invalidated_by_rescan(tmp_path) -> None:
    runtime = BridgeRuntime(
        RecordingWriter(), BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl"
    )  # type: ignore[arg-type]
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        prepared = runtime.dispatch(
            "register_prepare_write",
            {
                "position": 1,
                "address": 0x0010,
                "data": "34 12",
                "semantics": "RW",
                "known_register": True,
            },
        )
        runtime.dispatch("scan", {})

        with pytest.raises(RuntimeError, match="总线会话变化"):
            runtime.dispatch("register_execute_write", {"plan_id": prepared["plan_id"]})
    finally:
        runtime.shutdown()


def test_audit_log_rotates_without_losing_new_record(tmp_path) -> None:
    path = tmp_path / "audit.jsonl"
    logger = AuditLogger(path, max_bytes=1, backups=2)

    logger.record("first", {"value": 1}, outcome="succeeded")
    logger.record("second", {"value": 2}, outcome="succeeded")

    assert json.loads(path.read_text(encoding="utf-8"))["action"] == "second"
    assert json.loads((tmp_path / "audit.jsonl.1").read_text(encoding="utf-8"))["action"] == "first"


def test_running_worker_timeout_marks_bridge_stalled_and_fails_fast(tmp_path) -> None:
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")  # type: ignore[arg-type]
    started = threading.Event()
    release = threading.Event()

    def blocked(_backend: object) -> None:
        started.set()
        release.wait(1)

    try:
        with pytest.raises(TimeoutError, match="Worker 操作超时"):
            runtime._submit(blocked, timeout=0.01)
        assert started.is_set()

        before = time.perf_counter()
        with pytest.raises(RuntimeError, match="请求继续堆积"):
            runtime._submit("read_states", timeout=1)
        assert time.perf_counter() - before < 0.1
    finally:
        release.set()
        runtime.shutdown()


def test_framed_protocol_survives_profile_payloads() -> None:
    registry = load_command_registry()
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO)  # type: ignore[arg-type]
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        for profile, expected in [("ET1100", 216), ("LAN9252", 161), ("LAN9253", 176)]:
            catalog = runtime.dispatch("register_catalog", {"position": 1, "profile": profile})
            stream = io.BytesIO()
            write_frame(stream, {"type": "response", "result": catalog}, registry.max_frame_bytes)
            stream.seek(0)
            assert len(read_frame(stream, registry.max_frame_bytes)["result"]) == expected
        for index in range(100):
            profile = ("ET1100", "LAN9252", "LAN9253")[index % 3]
            assert runtime.dispatch("register_catalog", {"position": 1, "profile": profile})
    finally:
        runtime.shutdown()


def test_framed_protocol_rejects_oversized_input() -> None:
    stream = io.BytesIO((1025).to_bytes(4, "little"))
    with pytest.raises(FrameError, match="too large"):
        read_frame(stream, 1024)


def test_mutating_transport_failure_has_unknown_result() -> None:
    spec = load_command_registry().require("eeprom_flash")
    error = _structured_error(
        RuntimeError("native call lost"), request_id=7, method=spec.name, spec=spec, session_id=4
    )
    assert error["operation_result"] == "unknown"
    assert error["request_id"] == 7


def test_eeprom_exclusive_error_is_busy_and_not_unknown() -> None:
    spec = load_command_registry().require("register_read")
    error = _structured_error(
        EepromExclusiveError("EEPROM 正在烧录"),
        request_id=8,
        method=spec.name,
        spec=spec,
        session_id=4,
    )
    assert error["code"] == "EEPROM_BUSY"
    assert error["category"] == "busy"
    assert error["operation_result"] == "failed"


def test_metadata_lane_remains_available_during_native_stall() -> None:
    writer = RecordingWriter()
    runtime = BridgeRuntime(writer, BackendMode.DEMO)  # type: ignore[arg-type]
    started = threading.Event()
    release = threading.Event()

    def blocked(_backend: object) -> None:
        started.set()
        release.wait(1)

    hardware = threading.Thread(target=lambda: runtime._submit(blocked, timeout=1), daemon=True)
    hardware.start()
    try:
        assert started.wait(1)
        before = time.perf_counter()
        assert len(runtime.dispatch("register_catalog", {"position": 1, "profile": "ET1100"})) == 216
        assert time.perf_counter() - before < 0.25
    finally:
        release.set()
        hardware.join(timeout=1)
        runtime.shutdown()


def test_eeprom_exclusive_rejects_other_hardware_without_waiting(monkeypatch) -> None:
    runtime = BridgeRuntime(RecordingWriter(), BackendMode.DEMO)  # type: ignore[arg-type]
    started = threading.Event()
    release = threading.Event()

    def blocked_dispatch(method: str, _params: dict[str, Any]) -> dict[str, bool]:
        assert method == "eeprom_flash"
        started.set()
        release.wait(1)
        return {"success": True}

    monkeypatch.setattr(runtime, "_dispatch_serial", blocked_dispatch)
    flash = threading.Thread(target=lambda: runtime.dispatch("eeprom_flash", {}), daemon=True)
    flash.start()
    try:
        assert started.wait(1)
        before = time.perf_counter()
        with pytest.raises(EepromExclusiveError, match="EEPROM 正在"):
            runtime.dispatch("register_read", {"position": 1, "address": 0, "size": 1})
        assert time.perf_counter() - before < 0.25
    finally:
        release.set()
        flash.join(timeout=1)
        runtime.shutdown()


def test_state_repairs_are_rejected_while_cycle_runs() -> None:
    runtime = BridgeRuntime(RecordingWriter(), BackendMode.DEMO)  # type: ignore[arg-type]
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        runtime.dispatch("start_cycle", {"period_ms": 10})
        for method, params in (
            ("reconfig", {"position": 1}),
            ("recover", {"position": 1}),
        ):
            with pytest.raises(RuntimeError, match="周期通信运行时"):
                runtime.dispatch(method, params)
    finally:
        if runtime.cycle_running:
            runtime.dispatch("stop_cycle", {})
        runtime.shutdown()


def test_recover_bool_success_requires_clean_actual_state(monkeypatch) -> None:
    runtime = BridgeRuntime(RecordingWriter(), BackendMode.DEMO)  # type: ignore[arg-type]
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        broken = replace(runtime.slaves[0], state=EtherCatState.INIT, al_status=0x0050)
        original_submit = runtime._submit

        def controlled_submit(operation: Any, *args: Any, **kwargs: Any) -> Any:
            if operation == "recover":
                return True
            if operation == "read_states":
                return [broken, *runtime.slaves[1:]]
            return original_submit(operation, *args, **kwargs)

        monkeypatch.setattr(runtime, "_submit", controlled_submit)
        with pytest.raises(RuntimeError, match="状态复核未通过.*0x0050"):
            runtime.dispatch("recover", {"position": 1})
    finally:
        runtime.shutdown()


def test_expired_hardware_request_never_reaches_worker() -> None:
    runtime = BridgeRuntime(RecordingWriter(), BackendMode.DEMO)  # type: ignore[arg-type]
    try:
        with pytest.raises(TimeoutError, match="expired before execution"):
            runtime.dispatch("enumerate_adapters", {}, deadline_at_ms=0)
        assert runtime.worker.queue_depth == 0
    finally:
        runtime.shutdown()


def test_esi_full_flash_flow_auto_init_and_config_override(tmp_path, workspace) -> None:
    writer = RecordingWriter()
    audit_path = tmp_path / "audit.jsonl"
    runtime = BridgeRuntime(
        writer,
        BackendMode.DEMO,
        audit_path=audit_path,
        stability_wait_s=0,
        rediscovery_timeout_s=0,
    )  # type: ignore[arg-type]
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        assert runtime.dispatch("status", {})["slaves"][0].state is not EtherCatState.INIT

        source = workspace / "ESI示例" / "SlaveCTT_900e80.xml"
        source_before = source.read_bytes()
        loaded = runtime.dispatch(
            "esi_load", {"path": str(source)}
        )
        original_config = loaded["devices"][0].config_data
        override_config = "8D 0E 03 44 0A 00 00 00 00 00"
        target = runtime.dispatch(
            "sii_generate",
            {"document_id": loaded["document_id"], "ordinal": 0, "config_data": override_config},
        )
        assert target["size"] == 2048
        assert target["original_config_data"] == original_config
        assert target["effective_config_data"] == bytes.fromhex(override_config)
        assert target["device"].config_data == bytes.fromhex(override_config)
        assert source.read_bytes() == source_before
        assert target["layout"][0]["name"] == "Fixed SII area"
        assert target["layout"][-1]["kind"] == 0xFFFF
        assert runtime.dispatch("eeprom_capacity", {"position": 1}) == {"size": 2048}
        header = runtime.dispatch("eeprom_header", {"position": 1})
        assert len(header["header"]) == 16
        assert len(header["config_data"]) == 10
        assert header["size"] == 2048

        result = runtime.dispatch(
            "eeprom_flash",
            {"position": 1, "target_id": target["target_id"], "auto_reset": True},
        )
        assert result["success"] is True
        assert any(
            event == "progress" and payload.stage == "prepare-init"
            for event, payload in writer.events
        )
        flash = result["result"]
        assert flash.comparison.equal and flash.sii_valid and flash.semantic_valid
        assert flash.reset_sequence == (True, True, True)
        assert flash.rediscovered is True and flash.reload_verified is True

        repeated = runtime.dispatch(
            "eeprom_flash",
            {"position": 1, "target_id": target["target_id"], "auto_reset": True},
        )
        assert repeated["success"] is True
        assert repeated["result"].words_written == 0
        assert repeated["result"].reset_sequence is None
        assert repeated["result"].reload_verified is None

        read = runtime.dispatch("eeprom_read", {"position": 1, "target_id": target["target_id"]})
        assert read["sii_valid"] is True
        assert read["comparison"].equal is True
        assert read["identity"]["vendor_id"] == loaded["vendor_id"]
        audit = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
        assert audit[-1]["action"] == "eeprom_flash"
        assert audit[-1]["outcome"] == "succeeded"
        assert audit[-1]["details"]["vendor_id"] == loaded["vendor_id"]
        assert audit[-2]["details"]["auto_init"] is True
        assert audit[-1]["details"]["auto_init"] is False
    finally:
        runtime.shutdown()


def test_sii_generate_keeps_xml_capacity_when_connected_eeprom_size_differs(tmp_path, workspace) -> None:
    runtime = BridgeRuntime(
        RecordingWriter(),
        BackendMode.DEMO,
        audit_path=tmp_path / "audit.jsonl",
        stability_wait_s=0,
        rediscovery_timeout_s=0,
    )  # type: ignore[arg-type]
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        source = workspace / "ESI示例" / "SlaveCTT_900e80.xml"
        loaded = runtime.dispatch("esi_load", {"path": str(source)})
        document = runtime.documents[loaded["document_id"]]
        runtime.documents[loaded["document_id"]] = replace(
            document,
            devices=(replace(document.devices[0], byte_size=4096), *document.devices[1:]),
        )

        target = runtime.dispatch(
            "sii_generate",
            {"document_id": loaded["document_id"], "ordinal": 0},
        )
        assert target["size"] == 4096
        assert target["device"].byte_size == 4096
        assert runtime.documents[loaded["document_id"]].devices[0].byte_size == 4096
    finally:
        runtime.shutdown()


def test_esi_library_list_returns_all_devices(workspace) -> None:
    runtime = BridgeRuntime(RecordingWriter(), BackendMode.DEMO)  # type: ignore[arg-type]
    try:
        result = runtime.dispatch("esi_library_list", {"directory": str(workspace / "xml列表")})
        assert result["directory"] == str((workspace / "xml列表").resolve())
        assert result["entries"]
        assert all(entry["path"].lower().endswith(".xml") for entry in result["entries"])
        assert all(len(entry["config_data"]) >= 10 for entry in result["entries"])
    finally:
        runtime.shutdown()


def test_overview_op_runs_cycle_and_downgrade_stops_it():
    runtime = BridgeRuntime(RecordingWriter(), BackendMode.DEMO)
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        states = runtime.dispatch("request_state", {"position": 1, "state": 8})
        assert states[0].state is EtherCatState.OP
        assert runtime.cycle_running
        runtime.dispatch("request_state", {"position": 1, "state": 2})
        assert not runtime.cycle_running
        # Allow old start/stop events to arrive after the PREOP result.
        time.sleep(0.06)
        assert runtime.slaves[0].state is EtherCatState.PRE_OP
        assert not runtime.cycle_running
    finally:
        runtime.shutdown()
