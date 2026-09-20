import threading
import time
from dataclasses import replace

import pytest

from ethercat_debug_tool.backends.mock import MockBackend
from ethercat_debug_tool.models import EtherCatState
from ethercat_debug_tool.worker.ethercat_worker import EtherCatWorker


class TracingBackend(MockBackend):
    events: list[str] = []

    def map_process_data(self) -> int:
        self.events.append("map")
        return super().map_process_data()

    def request_state(self, position, state, timeout_us):
        self.events.append(f"state:{state.label}")
        return super().request_state(position, state, timeout_us)

    def exchange_process_data(self, timeout_us):
        self.events.append("exchange")
        return super().exchange_process_data(timeout_us)


class SlowCycleBackend(MockBackend):
    def exchange_process_data(self, timeout_us):
        time.sleep(0.02)
        return super().exchange_process_data(timeout_us)


class FailingOperationalBackend(MockBackend):
    def request_state(self, position, state, timeout_us):
        if state is EtherCatState.OP:
            raise RuntimeError("OP rejected")
        return super().request_state(position, state, timeout_us)


class FailingStartupBackend(MockBackend):
    def __init__(self) -> None:
        raise RuntimeError("backend startup failed")


def test_mock_p0_and_worker_serialization() -> None:
    worker = EtherCatWorker(MockBackend)
    worker.start()
    try:
        assert worker.submit("enumerate_adapters").result(timeout=2)[0].name == "demo0"
        worker.submit("connect", "demo0").result(timeout=2)
        assert len(worker.submit("scan").result(timeout=2)) == 3
        states = worker.submit("request_state", 1, EtherCatState.SAFE_OP, 1000).result(timeout=2)
        assert states[0].state is EtherCatState.SAFE_OP
        assert worker.submit("sdo_read", 1, 0x1018, 1, 4).result(timeout=2) == bytes.fromhex("34120000")
        worker.start_cycle(2, 1000).result(timeout=2)
        deadline = time.monotonic() + 1
        snapshots = []
        while time.monotonic() < deadline and not snapshots:
            snapshots.extend(event.payload for event in worker.poll_events() if event.kind == "process_data")
            time.sleep(0.005)
        assert snapshots and snapshots[-1].actual_wkc == snapshots[-1].expected_wkc
        worker.stop_cycle().result(timeout=2)
    finally:
        assert worker.shutdown()


def test_cycle_events_keep_the_session_that_started_the_cycle() -> None:
    worker = EtherCatWorker(MockBackend)
    worker.start()
    try:
        worker.submit("connect", "demo0", event_session_id=3).result(timeout=2)
        worker.submit("scan", event_session_id=3).result(timeout=2)
        worker.start_cycle(2, 1000, event_session_id=3).result(timeout=2)
        deadline = time.monotonic() + 1
        events = []
        while time.monotonic() < deadline and not any(
            event.kind == "process_data" for event in events
        ):
            events.extend(worker.poll_events())
            time.sleep(0.005)

        cycle_events = [
            event for event in events if event.kind in {"process_data", "cycle_started"}
        ]
        assert cycle_events
        assert all(event.session_id == 3 for event in cycle_events)
        worker.stop_cycle(event_session_id=3).result(timeout=2)
    finally:
        assert worker.shutdown()


def test_output_width_is_guarded() -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        backend.set_output(1, b"\x00" * 6)
        try:
            backend.set_output(1, b"\x00")
            raise AssertionError("short output should be rejected")
        except ValueError:
            pass
    finally:
        backend.disconnect()


def test_cycle_start_is_an_ordered_operational_state_closure() -> None:
    TracingBackend.events = []
    worker = EtherCatWorker(TracingBackend)
    worker.start()
    try:
        worker.submit("connect", "demo0").result(timeout=2)
        worker.submit("scan").result(timeout=2)
        worker.start_cycle(10, 1000).result(timeout=2)
        assert TracingBackend.events[:4] == ["map", "state:SAFE-OP", "exchange", "state:OP"]
        stopped = worker.stop_cycle().result(timeout=2)
        assert all(slave.state is EtherCatState.SAFE_OP for slave in stopped)
    finally:
        assert worker.shutdown()


def test_stop_control_is_not_starved_by_an_overdue_cycle() -> None:
    worker = EtherCatWorker(SlowCycleBackend)
    worker.start()
    try:
        worker.submit("connect", "demo0").result(timeout=2)
        worker.submit("scan").result(timeout=2)
        worker.start_cycle(1, 1000).result(timeout=2)
        started = time.monotonic()
        worker.stop_cycle().result(timeout=0.25)
        assert time.monotonic() - started < 0.25
    finally:
        assert worker.shutdown()


def test_failed_cycle_start_returns_bus_to_safe_op() -> None:
    worker = EtherCatWorker(FailingOperationalBackend)
    worker.start()
    try:
        worker.submit("connect", "demo0").result(timeout=2)
        worker.submit("scan").result(timeout=2)
        try:
            worker.start_cycle(10, 1000).result(timeout=2)
            raise AssertionError("OP failure should abort cycle startup")
        except RuntimeError as exc:
            assert "OP rejected" in str(exc)
        states = worker.submit("read_states").result(timeout=2)
        assert all(slave.state is EtherCatState.SAFE_OP for slave in states)
    finally:
        assert worker.shutdown()


def test_failed_cycle_start_preserves_al_error_and_stops_other_slaves() -> None:
    class WatchdogBackend(MockBackend):
        def request_state(self, position, state, timeout_us):
            result = super().request_state(position, state, timeout_us)
            if state is EtherCatState.OP:
                self._slaves[0] = replace(
                    self._slaves[0], state=EtherCatState.SAFE_OP, raw_state=0x14, al_status=0x001B
                )
                raise RuntimeError("SyncManager watchdog")
            return result

    worker = EtherCatWorker(WatchdogBackend)
    worker.start()
    try:
        worker.submit("connect", "demo0").result(timeout=2)
        worker.submit("scan").result(timeout=2)
        with pytest.raises(RuntimeError, match="SyncManager watchdog"):
            worker.start_cycle(10, 1000).result(timeout=2)
        states = worker.submit("read_states").result(timeout=2)
        assert states[0].raw_state == 0x14
        assert states[0].al_status == 0x001B
        assert all(slave.state is EtherCatState.SAFE_OP for slave in states)
        assert not any(event.kind == "slaves_changed" for event in worker.poll_events())
    finally:
        assert worker.shutdown()


def test_worker_startup_failure_fails_requests_instead_of_hanging() -> None:
    worker = EtherCatWorker(FailingStartupBackend)
    worker.start()
    deadline = time.monotonic() + 1
    events = []
    while time.monotonic() < deadline and not events:
        events.extend(worker.poll_events())
        time.sleep(0.005)

    assert any(event.kind == "worker_fatal" for event in events)
    with pytest.raises(RuntimeError, match="not running"):
        worker.submit("enumerate_adapters").result(timeout=0.1)
    assert worker.shutdown()


def test_worker_queue_is_bounded_during_native_stall() -> None:
    worker = EtherCatWorker(MockBackend, queue_limit=1)
    worker.start()
    started = threading.Event()
    release = threading.Event()

    def blocked(_backend: object) -> None:
        started.set()
        release.wait(1)

    first = worker.submit(blocked)
    assert started.wait(1)
    second = worker.submit("enumerate_adapters")
    rejected = worker.submit("enumerate_adapters")
    with pytest.raises(RuntimeError, match="queue is full"):
        rejected.result(timeout=0.1)
    release.set()
    first.result(timeout=1)
    second.result(timeout=1)
    assert worker.shutdown()



def test_cycle_detects_slave_leaving_op_even_with_good_wkc():
    worker = EtherCatWorker(MockBackend)
    worker.start()
    try:
        worker.submit("connect", "demo0").result(timeout=2)
        worker.submit("scan").result(timeout=2)
        worker.start_cycle(5, 1000).result(timeout=2)
        worker.submit("request_state", 1, EtherCatState.SAFE_OP, 1000).result(timeout=2)
        deadline = time.monotonic() + 1
        events = []
        while time.monotonic() < deadline:
            events.extend(worker.poll_events())
            if any(event.kind == "cycle_fault" for event in events):
                break
            time.sleep(0.005)
        assert any(event.kind == "cycle_fault" and "退出正常 OP" in str(event.payload) for event in events)
        states = worker.submit("read_states").result(timeout=2)
        assert all(slave.state is EtherCatState.SAFE_OP for slave in states)
    finally:
        worker.shutdown()
