from dataclasses import replace
from types import SimpleNamespace

import pytest

from ethercat_debug_tool.backends.mock import MockBackend
from ethercat_debug_tool.backends.pysoem_backend import DISCOVERY_FPRD_TIMEOUT_US, PysoemBackend
from ethercat_debug_tool.models import EtherCatState, SlaveIdentity, SlaveInfo


@pytest.mark.parametrize("model,size", [("ET1100", 2), ("E101", 2), ("LAN9252", 8), ("E252", 8), ("LAN9253", 8), ("E253", 8), ("Generic ESC", 0)])
@pytest.mark.parametrize("failure", [None, "timeout", "short"])
def test_hardware_is_read_only_once_per_scan(monkeypatch, model, size, failure):
    calls = []
    raw = bytearray(range(8))

    def read(address, length, timeout):
        calls.append((address, length, timeout))
        if failure == "timeout":
            raise RuntimeError("optional read timed out")
        return bytes(raw[:length - 1 if failure == "short" else length])

    slave = SimpleNamespace(state=2, al_status=0, _fprd=read)
    master = SimpleNamespace(slaves=[slave], read_state=lambda: None, config_init=lambda *args, **kwargs: 1)
    backend = PysoemBackend()
    backend._master = master
    backend._connected = True
    info = SlaveInfo(1, "test", SlaveIdentity(1, 2, 3), EtherCatState.PRE_OP, 0, 0, 0, chip_model=model)
    monkeypatch.setattr(backend, "_info", lambda *args: info)
    monkeypatch.setattr(backend, "map_process_data", lambda: None)
    first = backend.scan()[0]
    assert calls == ([(0x0E00, size, DISCOVERY_FPRD_TIMEOUT_US)] if size else [])
    assert first.esc_hardware == (bytes(raw[:size]).hex(" ").upper() if size and not failure else None)
    assert bool(first.esc_hardware_error) == bool(size and failure)
    raw[0] = 99
    slave.state = 4
    for _ in range(3):
        assert backend.read_states()[0] == replace(first, state=EtherCatState.SAFE_OP, raw_state=4)
    assert len(calls) == bool(size)
    second = backend.scan()[0]
    assert len(calls) == 2 * bool(size)
    if size and not failure:
        assert second.esc_hardware.startswith("63")


def test_mock_state_refresh_does_not_replace_hardware_snapshot():
    backend = MockBackend()
    backend.connect("demo0")
    first = backend.scan()
    backend._registers[0][0xE00] ^= 0xFF
    assert backend.read_states() == first
    assert backend.request_state(1, EtherCatState.SAFE_OP, 2000)[0].esc_hardware == first[0].esc_hardware
    assert backend.scan()[0].esc_hardware != first[0].esc_hardware
