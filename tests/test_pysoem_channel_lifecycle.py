from types import SimpleNamespace

import pytest

from ethercat_debug_tool.backends.base import CommunicationError
from ethercat_debug_tool.backends.passive_discovery import PassiveSlave
from ethercat_debug_tool.backends.pysoem_backend import PysoemBackend


@pytest.fixture
def channels(monkeypatch):
    events = []

    class Master:
        manual_state_change = False

        def __init__(self):
            self.slaves = []
            self.opened = False

        def open(self, adapter):
            assert not self.opened
            events.append(("soem_open", adapter))
            self.opened = True

        def close(self):
            assert self.opened
            events.append(("soem_close",))
            self.opened = False

        def config_init(self, *args, **kwargs):
            assert self.opened
            events.append(("soem_init",))
            self.slaves = [SimpleNamespace(state=1)]
            return 1

    class Passive:
        def __init__(self, adapter):
            self.adapter = adapter

        def open(self):
            events.append(("passive_open", self.adapter))

        def close(self):
            events.append(("passive_close",))

    master = Master()
    backend = PysoemBackend()
    backend._pysoem = SimpleNamespace(Master=lambda: master)
    discovered = [PassiveSlave(1, 1, 0, (1, 2, 3, 0), 0, 0x80, b"\x11\x00", b"",
                               bytes(8), 0x40C0, 0, 0)]

    def discover(adapter, *, transport):
        assert not master.opened
        events.append(("scan", adapter))
        return discovered

    monkeypatch.setattr("ethercat_debug_tool.backends.pysoem_backend.NpcapEthercatTransport", Passive)
    monkeypatch.setattr("ethercat_debug_tool.backends.pysoem_backend.passive_discover", discover)
    return backend, master, events


def test_scan_defers_soem_open_until_configuration(channels):
    backend, master, events = channels
    backend.connect("mock")
    assert backend.connected and events == [("passive_open", "mock")]
    assert backend.scan()[0].raw_state == 1
    assert not backend._master_open and master.slaves == []
    backend._ensure_operational(manual_state_change=True)
    assert events == [("passive_open", "mock"), ("scan", "mock"),
                      ("soem_open", "mock"), ("soem_init",)]
    assert backend._master_open and master.opened
    backend._ensure_operational(manual_state_change=True)
    assert len(events) == 4
    backend.disconnect()
    assert events[-2:] == [("passive_close",), ("soem_close",)]
    assert not backend.connected and not backend._master_open


def test_rescan_closes_soem_and_discards_old_configuration(channels):
    backend, master, events = channels
    backend.connect("mock")
    backend.scan()
    backend._ensure_operational(manual_state_change=True)
    backend._mapped = backend._mapping_attempted = True
    backend.scan()
    assert events[-2:] == [("soem_close",), ("scan", "mock")]
    assert not backend._master_open and master.slaves == []
    assert not backend._mapped and not backend._mapping_attempted
    backend._ensure_operational(manual_state_change=True)
    assert events[-2:] == [("soem_open", "mock"), ("soem_init",)]


def test_disconnect_after_scan_never_closes_unopened_soem(channels):
    backend, master, events = channels
    backend.connect("mock")
    backend.scan()
    backend.disconnect()
    assert events[-1] == ("passive_close",)
    assert all(event[0] not in {"soem_open", "soem_close"} for event in events)
    assert not backend._master_open and backend._master is None


def test_soem_open_failure_does_not_run_initialization(channels, monkeypatch):
    backend, master, events = channels
    backend.connect("mock")
    backend.scan()

    def fail_open(adapter):
        raise OSError("native channel unavailable")

    monkeypatch.setattr(master, "open", fail_open)
    with pytest.raises(CommunicationError, match="native channel unavailable"):
        backend._ensure_operational(manual_state_change=True)
    assert not backend._master_open and master.slaves == []
    assert all(event[0] != "soem_init" for event in events)
