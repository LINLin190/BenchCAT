from dataclasses import replace
from types import SimpleNamespace

import pytest

from ethercat_debug_tool.backends.pysoem_backend import PysoemBackend
from ethercat_debug_tool.models import EtherCatState, SlaveIdentity, SlaveInfo


class EepromSlave:
    state = 2
    al_status = 0

    def __init__(self, size=8, owner=b"\x01\x01", failure=None):
        self.size, self.owner, self.failure = size, owner, failure
        self.status = 0x40C0 if size == 8 else 0x4080
        self.data = bytes.fromhex("8D 0E 03 44 88 13 00 00 00 00 00 00 00 00 E4 00")
        self.events = []
        self.word = 0

    def _fprd(self, address, size, timeout):
        self.events.append(("read", address, size))
        if address == 0xE00:
            return bytes.fromhex("01 00 52 92 1C 00 00 00")
        if address == 0x502:
            return self.status.to_bytes(2, "little")
        if address == 0x500:
            return self.owner[:size]
        if address == 0x508:
            if self.failure == "read":
                raise RuntimeError("data read failed")
            return self.data[self.word * 2:self.word * 2 + size - (self.failure == "short")]
        raise AssertionError(hex(address))

    def _fpwr(self, address, data, timeout):
        self.events.append(("write", address, data))
        if address == 0x500:
            if self.failure == "restore" and data == b"\x01":
                raise RuntimeError("restore failed")
            self.owner = data + bytes([data[0] & 1])
        elif address == 0x504:
            self.word = int.from_bytes(data, "little")
        elif address == 0x502:
            assert data in (b"\x00\x00", b"\x00\x01")
            self.status &= ~0x6000
            if data == b"\x00\x01":
                if self.failure == "command":
                    self.status |= 0x2000
                if self.failure == "busy":
                    self.status |= 0x8000
        else:
            raise AssertionError(hex(address))


@pytest.mark.parametrize("size", [4, 8])
@pytest.mark.parametrize("owner", [b"\x00\x00", b"\x01\x01", b"\x00\x01", b"\x02\x00"])
def test_prefix_reads_words_and_restores_owner(size, owner):
    slave = EepromSlave(size, owner)
    assert PysoemBackend()._read_eeprom_prefix(slave, slave.status) == slave.data
    words = [int.from_bytes(data, "little") for op, address, data in slave.events if op == "write" and address == 0x504]
    assert words == list(range(0, 8, size // 2))
    expected = 1 if owner[1] & 1 else owner[0]
    assert slave.owner[0] == expected
    assert slave.events[-1] == ("read", 0x500, 1)


def test_checked_read_uses_esc_command_and_restores_owner():
    slave = EepromSlave(owner=b"\x01\x01")
    backend = PysoemBackend()
    backend._master = SimpleNamespace(slaves=[slave])
    backend._connected = True
    readback = backend.eeprom_read_checked(1, 2)
    assert readback.data == slave.data[4:8]
    assert readback.wkc == 1
    assert readback.status & 0x8000 == 0
    assert slave.owner[0] == 1
    assert ("write", 0x504, (2).to_bytes(4, "little")) in slave.events


@pytest.mark.parametrize("read_size", [4, 8])
def test_block_read_uses_supported_width_and_one_ownership_cycle(read_size):
    slave = EepromSlave(size=read_size, owner=b"\x01\x01")
    backend = PysoemBackend()
    backend._master = SimpleNamespace(slaves=[slave])
    backend._connected = True
    readback = backend.eeprom_read_block(1, 0, 16)
    assert readback.data == slave.data
    assert readback.wkc == 1
    addresses = [int.from_bytes(data, "little") for op, address, data in slave.events
                 if op == "write" and address == 0x504]
    assert addresses == list(range(0, 8, read_size // 2))
    assert sum(op == "write" and address == 0x500 for op, address, _ in slave.events) == 3
    assert slave.owner[0] == 1


def test_checked_read_reports_command_error_and_status():
    slave = EepromSlave(failure="command")
    backend = PysoemBackend()
    backend._master = SimpleNamespace(slaves=[slave])
    backend._connected = True
    with pytest.raises(RuntimeError, match="0x0502=0x20C0"):
        backend.eeprom_read_checked(1, 0)
    assert slave.owner[0] == 1


@pytest.mark.parametrize("failure", ["read", "short", "command", "busy"])
def test_read_failures_still_restore_owner(failure):
    slave = EepromSlave(failure=failure)
    with pytest.raises(RuntimeError):
        PysoemBackend()._read_eeprom_prefix(slave, slave.status)
    assert slave.owner[0] == 1


def test_busy_does_not_take_ownership_and_restore_failure_is_reported():
    slave = EepromSlave()
    with pytest.raises(RuntimeError, match="忙"):
        PysoemBackend()._read_eeprom_prefix(slave, 0x8000)
    assert not slave.events
    slave = EepromSlave(failure="restore")
    with pytest.raises(RuntimeError, match="控制权归还失败"):
        PysoemBackend()._read_eeprom_prefix(slave, slave.status)


def test_scan_keeps_pre_read_status_and_refresh_does_not_read_eeprom(monkeypatch):
    slave = EepromSlave()
    backend = PysoemBackend()
    backend._master = SimpleNamespace(slaves=[slave], config_init=lambda *a, **kw: 1, read_state=lambda: None)
    backend._connected = True
    info = SlaveInfo(1, "test", SlaveIdentity(1, 2, 3), EtherCatState.PRE_OP, 0, 0, 0, chip_model="LAN9252")
    monkeypatch.setattr(backend, "_info", lambda *a: info)
    monkeypatch.setattr(backend, "map_process_data", lambda: None)
    first = backend.scan()[0]
    assert first.eeprom_status == 0x40C0
    assert first.eeprom_prefix == slave.data.hex(" ").upper()
    assert slave.status == 0x00C0
    slave.events.clear()
    assert backend.read_states()[0] == replace(first, raw_state=2)
    assert not slave.events
    assert backend.read_states(refresh_eeprom=True)[0].eeprom_status == 0x00C0
    assert slave.events == [("read", 0x502, 2)]
    assert backend._slaves[0].eeprom_prefix == first.eeprom_prefix
    slave.data = bytes(16)
    assert backend.scan()[0].eeprom_prefix == bytes(16).hex(" ").upper()


def test_short_status_is_not_a_zero_value():
    backend = PysoemBackend()
    info = SlaveInfo(1, "test", SlaveIdentity(1, 2, 3), EtherCatState.PRE_OP, 0, 0, 0)
    result = backend._eeprom_status_info(info, SimpleNamespace(_fprd=lambda *a: b"\x00"))
    assert result.eeprom_status is None
    assert result.eeprom_status_error
