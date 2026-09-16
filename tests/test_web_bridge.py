from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from ethercat_debug_tool import web_bridge
from ethercat_debug_tool.models import BackendMode


class _FakeRegistry:
    max_frame_bytes = 1024
    commands = {
        "status": SimpleNamespace(lane="control", timeout_ms=2000),
        "switch_mode": SimpleNamespace(lane="hardware", timeout_ms=2000),
    }

    def require(self, method: str) -> Any:
        return self.commands[method]


class _FakeRuntime:
    created_mode: BackendMode | None = None

    def __init__(self, writer: Any, mode: BackendMode, *, audit_path: Any) -> None:
        self.writer = writer
        self.registry = _FakeRegistry()
        self.session_id = 7
        self.created_mode = mode
        type(self).created_mode = mode
        self.stopped = False

    def snapshot(self) -> dict[str, Any]:
        return {
            "mode": "real",
            "phase": "disconnected",
            "adapter": None,
            "connected": False,
            "cycle_running": False,
            "slaves": [],
            "session_id": self.session_id,
            "revision": 0,
        }

    def dispatch(self, method: str, params: dict[str, Any], *, deadline_at_ms: int) -> Any:
        assert deadline_at_ms > 0
        if method == "status":
            return self.snapshot()
        return params

    def shutdown(self) -> None:
        self.stopped = True


def test_web_service_is_real_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    monkeypatch.setattr(web_bridge, "BridgeRuntime", _FakeRuntime)
    service = web_bridge.WebBridgeService(web_bridge.EventHub(), audit_path=tmp_path / "audit.jsonl")
    try:
        envelope = service.request("status", {}, None)
        assert _FakeRuntime.created_mode is BackendMode.REAL
        assert envelope["snapshot"]["mode"] == "real"
        assert envelope["snapshot"]["host_generation"] == web_bridge.HOST_GENERATION
        with pytest.raises(PermissionError, match="仅支持实际设备模式"):
            service.request("switch_mode", {"mode": "demo"}, envelope["session_id"])
    finally:
        service.shutdown()


def test_web_event_writer_publishes_snapshot_generation() -> None:
    events = web_bridge.EventHub()
    subscriber = events.subscribe()
    writer = web_bridge.WebEventWriter(events)
    writer.event("bus_snapshot", {"session_id": 3}, 3)
    event = subscriber.get_nowait()
    assert event["host_generation"] == web_bridge.HOST_GENERATION
    assert event["data"]["host_generation"] == web_bridge.HOST_GENERATION
    assert event["session_id"] == 3
