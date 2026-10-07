from __future__ import annotations

import threading
from dataclasses import replace
from types import SimpleNamespace

import pytest

from ethercat_debug_tool.backends.mock import MockBackend
from ethercat_debug_tool.backends.passive_discovery import PassiveNoResponse
from ethercat_debug_tool.backends.pysoem_backend import PysoemBackend
from ethercat_debug_tool.bridge import BridgeRuntime
from ethercat_debug_tool.models import BackendMode, EtherCatState
from ethercat_debug_tool.worker.ethercat_worker import EtherCatWorker


class ProbeTransport:
    def __init__(self):
        self.failed = True
        self.calls = []

    def read_many(self, command, adp, requests, timeout_us):
        self.calls.append((command, adp, requests, timeout_us))
        if adp == 0 and self.failed:
            raise PassiveNoResponse("无响应")
        return [(b"\x12\x00", 1), (b"\x11\x00", 1)]


def test_probe_is_read_only_and_continues_after_one_slave_times_out():
    backend = PysoemBackend()
    backend._master = SimpleNamespace()
    backend._connected = True
    backend._slaves = MockBackend()._slaves[:2]
    backend._passive = ProbeTransport()
    initial = backend._slaves[0]
    states = backend.probe_states()
    assert states[0].state_error and states[0].state == initial.state
    assert states[1].state is EtherCatState.PRE_OP
    assert states[1].raw_state == 0x12 and states[1].al_status == 0x11
    assert not states[1].state_error
    assert backend._passive.calls == [
        (0x01, 0, [(0x0130, 2), (0x0134, 2)], 2000),
        (0x01, -1, [(0x0130, 2), (0x0134, 2)], 2000),
    ]
    backend._passive.failed = False
    restored = backend.probe_states()
    assert not restored[0].state_error
    assert restored[0].state is EtherCatState.PRE_OP
    assert restored[0].identity == initial.identity


@pytest.mark.parametrize("values", [
    [(b"\x02\x00", 0), (b"\x00\x00", 1)],
    [(b"\x02", 1), (b"\x00\x00", 1)],
    [(b"\x00\x00", 1), (b"\x00\x00", 1)],
])
def test_probe_never_presents_invalid_responses_as_online(values):
    backend = PysoemBackend()
    backend._master = SimpleNamespace()
    backend._connected = True
    backend._slaves = MockBackend()._slaves[:1]
    backend._passive = SimpleNamespace(read_many=lambda *args: values)
    assert backend.probe_states()[0].state_error


class Writer:
    def __init__(self):
        self.events = []
        self.changed = threading.Event()

    def event(self, kind, payload, session_id=None):
        self.events.append((kind, payload, session_id))
        if kind == "slave_communication_changed":
            self.changed.set()


class SwitchableBackend(MockBackend):
    failed = False
    probes = 0

    def probe_states(self):
        self.probes += 1
        return [replace(info, state_error="无响应" if self.failed and info.position == 1 else None)
                for info in self._slaves]


def make_runtime(monkeypatch, tmp_path, *, background=False):
    backend = SwitchableBackend()
    worker = EtherCatWorker(lambda: backend)
    worker.start()
    monkeypatch.setattr(BridgeRuntime, "_new_worker", staticmethod(lambda mode: worker))
    if not background:
        monkeypatch.setattr(BridgeRuntime, "_idle_monitor_loop", lambda self: None)
    writer = Writer()
    runtime = BridgeRuntime(writer, BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")
    runtime.dispatch("connect", {"adapter": "demo0"})
    runtime.dispatch("scan", {})
    return runtime, backend, writer


def test_idle_monitor_preserves_session_and_only_notifies_changes(monkeypatch, tmp_path):
    runtime, backend, writer = make_runtime(monkeypatch, tmp_path)
    try:
        session = runtime.session_id
        backend.failed = True
        runtime._probe_idle_bus()
        assert runtime.slaves[0].state_error
        assert not runtime.slaves[1].state_error
        revision = runtime.snapshot()["revision"]
        runtime._probe_idle_bus()
        assert runtime.snapshot()["revision"] == revision
        backend.failed = False
        runtime._probe_idle_bus()
        assert not runtime.slaves[0].state_error
        assert runtime.session_id == session
        changes = [(payload, sid) for kind, payload, sid in writer.events
                   if kind == "slave_communication_changed"]
        assert changes == [({"unavailable": [1], "restored": []}, session),
                           ({"unavailable": [], "restored": [1]}, session)]
    finally:
        runtime.shutdown()


def test_idle_monitor_skips_busy_exclusive_cyclic_and_disconnected_states(monkeypatch, tmp_path):
    runtime, backend, _ = make_runtime(monkeypatch, tmp_path)
    try:
        runtime._command_lock.acquire()
        try:
            runtime._probe_idle_bus()
        finally:
            runtime._command_lock.release()
        runtime._eeprom_exclusive = True
        runtime._probe_idle_bus()
        runtime._eeprom_exclusive = False
        runtime.master_state.cycle_started(runtime.slaves)
        runtime._probe_idle_bus()
        runtime.master_state.cycle_stopped(runtime.slaves)
        runtime.dispatch("disconnect", {})
        runtime._probe_idle_bus()
        assert backend.probes == 0
    finally:
        runtime.shutdown()


def test_background_monitor_detects_loss_and_return_without_user_operations(monkeypatch, tmp_path):
    runtime, backend, writer = make_runtime(monkeypatch, tmp_path, background=True)
    try:
        backend.failed = True
        assert writer.changed.wait(2)
        assert runtime.slaves[0].state_error
        writer.changed.clear()
        backend.failed = False
        assert writer.changed.wait(2)
        assert not runtime.slaves[0].state_error
    finally:
        runtime.shutdown()
    assert not runtime._idle_monitor.is_alive()
