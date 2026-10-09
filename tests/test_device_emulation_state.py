from __future__ import annotations

from types import SimpleNamespace

import pytest

from ethercat_debug_tool.backends.passive_discovery import PassiveDiscoveryError
from ethercat_debug_tool.backends.pysoem_backend import PysoemBackend, StateRequestFailure
from ethercat_debug_tool.models import EtherCatState, SlaveIdentity, SlaveInfo
from ethercat_debug_tool.services.register_service import ResetService


class AlTransport:
    def __init__(
        self, configuration: int, state: int, code: int = 0, *, mailbox_ready: bool = True
    ) -> None:
        self.configuration = configuration
        self.state = state
        self.code = code
        self.mailbox_ready = mailbox_ready
        self.pending_al = False
        self.reject_op = False
        self.writes: list[int] = []
        self.eeprom_writes: list[tuple[int, bytes]] = []
        self.reset_bytes: list[bytes] = []

    def aprd(self, position: int, address: int, size: int) -> tuple[bytes, int]:
        assert position == 1
        if address == 0x0800:
            return (bytes.fromhex("00108000260001008010800022000100") if self.mailbox_ready else bytes(16)), 1
        if address == 0x0220:
            return int(self.pending_al).to_bytes(size, "little"), 1
        if address == 0x0005:
            return b"\x02", 1
        value = {0x0141: self.configuration, 0x0130: self.state, 0x0134: self.code, 0x0502: 0x00C0}[address]
        return value.to_bytes(size, "little"), 1

    def apwr(self, position: int, address: int, data: bytes) -> None:
        if (position, address) == (1, 0x0040):
            self.reset_bytes.append(data)
            return
        assert (position, address) == (1, 0x0120)
        if self.pending_al and (self.configuration & 1) == 0:
            raise PassiveDiscoveryError("APWR 0x0120 写入失败，WKC=0")
        value = int.from_bytes(data, "little")
        self.writes.append(value)
        if value == int(EtherCatState.OP) and self.reject_op:
            self.code = 0x0011
            return
        self.state = value if self.configuration & 1 else value & 0x0F
        if (self.configuration & 1) == 0 and value & 0x10:
            self.code = 0

    def eeprom_read(self, position: int, word_address: int, word_count: int) -> bytes:
        assert position == 1
        return bytes(range(word_address * 2, word_address * 2 + word_count * 2))

    def eeprom_write(self, position: int, word_address: int, data: bytes) -> None:
        assert position == 1
        self.eeprom_writes.append((word_address, data))


class AlSlave:
    name = "Slave"
    man = id = rev = 1
    input = output = b""

    def __init__(self, master: AlMaster) -> None:
        self.master = master
        self.state = master.transport.state
        self.al_status = master.transport.code

    def write_state(self) -> int:
        self.master.transport.apwr(1, 0x0120, int(self.state).to_bytes(2, "little"))
        return 1

    def state_check(self, expected: int, timeout_us: int) -> int:
        self.master.read_state()
        return self.state & 0x0F


class AlMaster:
    manual_state_change = False

    def __init__(self, transport: AlTransport) -> None:
        self.transport = transport
        self.slaves: list[AlSlave] = []
        self.config_init_calls: list[bool] = []

    def config_init(self, *_args: object, **_kwargs: object) -> int:
        self.config_init_calls.append(self.manual_state_change)
        self.transport.apwr(1, 0x0120, b"\x01\x00")
        if not self.manual_state_change:
            self.transport.apwr(1, 0x0120, b"\x12\x00")
        self.transport.mailbox_ready = True
        self.slaves = [AlSlave(self)]
        return 1

    def read_state(self) -> None:
        for slave in self.slaves:
            slave.state = self.transport.state
            slave.al_status = self.transport.code


def backend(
    configuration: int, state: int, code: int = 0, *, mailbox_ready: bool = True
) -> tuple[PysoemBackend, AlTransport, AlMaster]:
    transport = AlTransport(configuration, state, code, mailbox_ready=mailbox_ready)
    master = AlMaster(transport)
    result = PysoemBackend()
    result._connected = True
    result._passive = transport
    result._master = master
    result._master_open = True
    result._slaves = [
        SlaveInfo(1, "Slave", SlaveIdentity(1, 1, 1), EtherCatState(state & 0x0F), code, 0, 0)
    ]
    return result, transport, master


@pytest.mark.parametrize("process_data", [False, True])
def test_emulated_preop_and_init_never_initialize_soem(process_data: bool) -> None:
    device, transport, master = backend(0x0F, 1)
    assert device.request_state(1, EtherCatState.PRE_OP, 1000, process_data=process_data)[0].raw_state == 2
    assert device.request_state(1, EtherCatState.INIT, 1000, process_data=process_data)[0].raw_state == 1
    assert transport.writes == [2, 1]
    assert master.config_init_calls == []


def test_emulated_clear_error_writes_state_without_ack() -> None:
    device, transport, master = backend(0x0F, 0x12)
    assert device.clear_error(1, 1000)[0].raw_state == 2
    assert transport.writes == [2]
    assert master.config_init_calls == []


def test_standard_clear_error_uses_ack_without_soem_initialization() -> None:
    device, transport, master = backend(0, 0x12, 0x16)
    assert device.clear_error(1, 1000)[0].raw_state == 2
    assert transport.writes == [0x12]
    assert master.config_init_calls == []


def test_standard_preop_initializes_mailbox_without_automatic_preop_ack() -> None:
    device, transport, master = backend(0, 1, mailbox_ready=False)
    assert device.request_state(1, EtherCatState.PRE_OP, 1000, process_data=False)[0].raw_state == 2
    assert master.config_init_calls == [True]
    assert master.manual_state_change is False
    assert transport.writes == [1, 2]


def test_first_preop_request_opens_soem_only_when_mailbox_configuration_is_needed(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    device._master_open = False
    device._adapter_name = "mock"
    opened = []
    master.open = lambda adapter: opened.append(adapter)
    initialize = master.config_init

    def init_after_open(*args, **kwargs):
        assert opened == ["mock"] and device._master_open
        return initialize(*args, **kwargs)

    master.config_init = init_after_open
    assert device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)[0].raw_state == 2
    assert opened == ["mock"] and transport.writes == [1, 2]


def test_direct_preop_with_existing_mailbox_leaves_soem_closed(state_clock):
    device, transport, master = backend(0, 1)
    device._master_open = False
    assert device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)[0].raw_state == 2
    assert not device._master_open and master.config_init_calls == []
    assert transport.writes == [2]


def test_standard_preop_uses_existing_mailbox_without_soem_initialization() -> None:
    device, transport, master = backend(0, 1)
    assert device.request_state(1, EtherCatState.PRE_OP, 1000, process_data=False)[0].raw_state == 2
    assert transport.writes == [2]
    assert master.config_init_calls == []


def test_pending_al_event_does_not_trigger_soem_initialization() -> None:
    device, transport, master = backend(0, 1, mailbox_ready=False)
    transport.pending_al = True
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 1000, process_data=False)
    assert caught.value.timed_out
    assert caught.value.phase == "transition"
    assert caught.value.target is EtherCatState.PRE_OP
    assert transport.writes == []
    assert master.config_init_calls == []


def test_emulated_state_request_reports_nonzero_al_code() -> None:
    device, transport, master = backend(0x0F, 0x12, 0x16)
    with pytest.raises(Exception, match="AL status code 0x0016.*device emulation 1"):
        device.clear_error(1, 1000)
    assert transport.writes == [2]
    assert master.config_init_calls == []


def test_standard_state_request_reports_rejected_al_write() -> None:
    device, transport, master = backend(0, 1)
    master.slaves = [AlSlave(master)]

    def reject_write(*args):
        raise PassiveDiscoveryError("APWR 0x0120 写入失败，WKC=0")

    transport.apwr = reject_write
    with pytest.raises(StateRequestFailure, match="AL Control 写入失败.*WKC=0"):
        device.request_state(1, EtherCatState.PRE_OP, 1000, process_data=False)
    assert transport.writes == []


@pytest.fixture
def state_clock(monkeypatch):
    from ethercat_debug_tool.backends import pysoem_backend

    class Clock:
        now = 0.0
        on_sleep = staticmethod(lambda: None)

        def sleep(self, seconds):
            self.now += seconds
            self.on_sleep()

    clock = Clock()
    monkeypatch.setattr(pysoem_backend.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(pysoem_backend.time, "sleep", clock.sleep)
    return clock


def test_pending_al_timeout_never_writes_or_initializes(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    device._master_open = False
    transport.pending_al = True
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.SAFE_OP, 2_000_000, process_data=False)
    assert state_clock.now == pytest.approx(2)
    assert caught.value.timed_out and caught.value.target is EtherCatState.PRE_OP
    assert caught.value.sources == {1: EtherCatState.INIT}
    assert transport.writes == master.config_init_calls == []
    assert not device._master_open


def test_request_to_current_state_does_not_fill_al_mailbox(state_clock):
    device, transport, master = backend(0, 1)
    transport.pending_al = True
    assert device.request_state(1, EtherCatState.INIT, 2_000_000, process_data=False)[0].state is EtherCatState.INIT
    assert state_clock.now == 0 and transport.writes == master.config_init_calls == []


def test_earlier_pending_request_reaching_target_is_success(state_clock):
    device, transport, master = backend(0, 1)
    transport.pending_al = True
    state_clock.on_sleep = lambda: setattr(transport, "state", 2)
    assert device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)[0].state is EtherCatState.PRE_OP
    assert transport.writes == master.config_init_calls == []


def test_pending_wait_and_transition_share_deadline(state_clock):
    device, transport, master = backend(0, 1)
    transport.pending_al = True
    state_clock.on_sleep = lambda: setattr(transport, "pending_al", state_clock.now < 1.2)
    transport.apwr = lambda position, address, data: transport.writes.append(int.from_bytes(data, "little"))
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)
    assert state_clock.now == pytest.approx(2, abs=0.001)
    assert caught.value.timed_out and transport.writes == [2]
    assert master.config_init_calls == []


def test_initialization_pending_init_is_consumed_before_preop(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    write = transport.apwr

    def no_firmware(position, address, data):
        write(position, address, data)
        transport.pending_al = True

    transport.apwr = no_firmware
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)
    assert caught.value.timed_out and caught.value.target is EtherCatState.PRE_OP
    assert state_clock.now == pytest.approx(2, abs=0.001)
    assert transport.writes == [1] and master.config_init_calls == [True]


def test_manual_safeop_requires_preop_and_mapping(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    calls = []

    def config_map():
        assert master.manual_state_change and transport.state == 2
        calls.append("map")
        return 0

    master.config_map = config_map
    assert device.request_state(1, EtherCatState.SAFE_OP, 2_000_000, process_data=False)[0].state is EtherCatState.SAFE_OP
    assert transport.writes == [1, 2, 4] and calls == ["map"]
    assert device._mapped and master.manual_state_change is False


@pytest.mark.parametrize("target", [EtherCatState.PRE_OP, EtherCatState.SAFE_OP])
def test_native_discovery_failure_waits_for_pending_state_request(state_clock, target):
    device, transport, master = backend(0, 1, mailbox_ready=False)

    def incomplete_init(*args, **kwargs):
        master.config_init_calls.append(master.manual_state_change)
        transport.apwr(1, 0x0120, b"\x01\x00")
        transport.pending_al = True
        return 0

    master.config_init = incomplete_init
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, target, 2_000_000, process_data=False)
    assert caught.value.timed_out
    assert caught.value.initial_states == {1: EtherCatState.INIT}
    assert caught.value.observed == {1: (1, 0)}
    assert state_clock.now == pytest.approx(2, abs=0.001)
    assert transport.writes == [1] and master.config_init_calls == [True]


def test_native_discovery_failure_without_pending_request_is_not_timeout(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    master.config_init = lambda *args, **kwargs: 0
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)
    assert not caught.value.timed_out
    assert state_clock.now == 0 and transport.writes == []


def test_native_discovery_failure_preserves_al_rejection(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)

    def rejected_init(*args, **kwargs):
        transport.pending_al = True
        transport.state, transport.code = 0x11, 0x0016
        return 0

    master.config_init = rejected_init
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)
    assert not caught.value.timed_out
    assert caught.value.observed == {1: (0x11, 0x0016)}
    assert state_clock.now == 0 and transport.writes == []


def test_manual_state_uses_live_registers_over_stale_native_state(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    master.slaves = [AlSlave(master)]
    master.slaves[0].state = 0
    master.read_state = lambda: pytest.fail("reading stale native state")
    assert device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)[0].state is EtherCatState.PRE_OP
    assert master.config_init_calls == [] and transport.writes == [2]


def test_manual_safeop_downgrade_does_not_reconfigure_bus(state_clock):
    device, transport, master = backend(0, 8)
    assert device.request_state(1, EtherCatState.SAFE_OP, 2_000_000, process_data=False)[0].state is EtherCatState.SAFE_OP
    assert master.config_init_calls == [] and transport.writes == [4]


def test_manual_safeop_preop_failure_stops_before_mapping(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    write = transport.apwr

    def leave_preop_pending(position, address, data):
        if int.from_bytes(data, "little") == 2:
            transport.writes.append(2)
            transport.pending_al = True
        else:
            write(position, address, data)

    transport.apwr = leave_preop_pending
    master.config_map = lambda: pytest.fail("mapping before PRE-OP")
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.SAFE_OP, 2_000_000, process_data=False)
    assert caught.value.target is EtherCatState.PRE_OP and caught.value.timed_out
    assert transport.writes == [1, 2]


def test_initialization_consumes_request_budget(state_clock):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    initialize = master.config_init

    def slow_init(*args, **kwargs):
        state_clock.now += 2.1
        return initialize(*args, **kwargs)

    master.config_init = slow_init
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)
    assert caught.value.phase == "initialization" and caught.value.timed_out
    assert transport.writes == [1] and master.manual_state_change is False


def test_state_read_failure_stops_before_any_write(state_clock):
    device, transport, master = backend(0, 1)
    read = transport.aprd

    def fail_read(position, address, size):
        if address == 0x0130:
            raise PassiveDiscoveryError("no response")
        return read(position, address, size)

    transport.aprd = fail_read
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.PRE_OP, 2_000_000, process_data=False)
    assert caught.value.read_failed and not caught.value.timed_out
    assert transport.writes == master.config_init_calls == []


@pytest.mark.parametrize("mapping_fails", [False, True])
def test_native_configuration_waits_use_remaining_budget_and_restore_settings(state_clock, mapping_fails):
    device, transport, master = backend(0, 1, mailbox_ready=False)
    original = dict(ret=2000, safe=20_000, eeprom=20_000, tx_mailbox=20_000, rx_mailbox=700_000, state=9_000_000)
    timeouts = SimpleNamespace(**original)
    device._pysoem = SimpleNamespace(settings=SimpleNamespace(timeouts=timeouts))
    initialize = master.config_init

    def slow_init(*args, **kwargs):
        assert timeouts.state <= 2_000_000
        state_clock.now += 1.4
        return initialize(*args, **kwargs)

    def config_map():
        assert timeouts.state == timeouts.rx_mailbox == 600_000
        if mapping_fails:
            raise RuntimeError("configuration failed")
        state_clock.now += 0.7
        return 0

    master.config_init, master.config_map = slow_init, config_map
    with pytest.raises(StateRequestFailure) as caught:
        device.request_state(1, EtherCatState.SAFE_OP, 2_000_000, process_data=False)
    assert caught.value.phase == "pdo_mapping" and caught.value.timed_out is not mapping_fails
    assert vars(timeouts) == original and master.manual_state_change is False
    assert transport.writes == [1, 2] and device._mapped is not mapping_fails


def test_direct_op_reports_slave_rejection() -> None:
    device, transport, master = backend(0, 1)
    transport.reject_op = True
    with pytest.raises(Exception, match="请求 OP 失败.*AL status code 0x0011"):
        device.request_state(1, EtherCatState.OP, 1000, process_data=False)
    assert transport.writes == [8]
    assert master.config_init_calls == []


def test_status_and_eeprom_io_ignore_stale_native_slave_context() -> None:
    device, transport, master = backend(0x0F, 2)
    master.slaves = [AlSlave(master)]
    master.slaves[0].state = 0
    master.read_state = lambda: pytest.fail("native fixed-address state read")  # type: ignore[method-assign]
    assert device.read_states()[0].state is EtherCatState.PRE_OP
    assert device.eeprom_read_block(1, 1, 4).data == b"\x02\x03\x04\x05"
    device.eeprom_write(1, 1, b"\xAA\xBB")
    assert ResetService(device).reset_ecat(1) == (True, True, True)
    assert transport.eeprom_writes == [(1, b"\xAA\xBB")]
    assert transport.reset_bytes == [b"R", b"E", b"S"]
    assert master.config_init_calls == []


def test_invalid_al_status_does_not_replace_last_known_state_with_none() -> None:
    device, transport, _ = backend(0x0F, 2)
    transport.state = 0
    with pytest.raises(Exception, match="AL 状态值无效：0x0000"):
        device.read_states()
    assert device._slaves[0].state is EtherCatState.PRE_OP


@pytest.mark.parametrize("failure", ["timeout", "wkc", "invalid"])
def test_state_read_recovers_without_writes_or_exposing_transient_failure(monkeypatch, failure):
    device, transport, _ = backend(0x0F, 2)
    read = transport.aprd
    attempts = 0

    def transient_read(position, address, size):
        nonlocal attempts
        if address == 0x0130:
            attempts += 1
            if attempts < 3:
                if failure == "timeout":
                    raise PassiveDiscoveryError("timeout")
                return bytes(2), 0 if failure == "wkc" else 1
        return read(position, address, size)

    monkeypatch.setattr(transport, "aprd", transient_read)
    info = device.read_states()[0]
    assert attempts == 3 and info.state is EtherCatState.PRE_OP
    assert info.state_error is None and not transport.writes
