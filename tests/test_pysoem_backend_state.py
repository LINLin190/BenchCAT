import pytest

from ethercat_debug_tool.backends.pysoem_backend import DISCOVERY_FPRD_TIMEOUT_US, PysoemBackend
from ethercat_debug_tool.models import EtherCatState, SlaveIdentity, SlaveInfo


class FakeSlave:
    def __init__(self, name: str, al_status: int, al_code: int) -> None:
        self.name = name
        self.state = al_status
        self.al_status = al_status
        self._al_code = al_code

    def _fprd(self, address: int, size: int, timeout_us: int) -> bytes:
        assert (address, size) == (0x0134, 2)
        return self._al_code.to_bytes(2, "little")


class FakeMaster:
    def __init__(self, slaves: list[FakeSlave]) -> None:
        self.slaves = slaves

    def read_state(self) -> None:
        pass


def test_bus_state_error_reports_each_slave_without_using_master_fprd() -> None:
    backend = PysoemBackend()
    backend._master = FakeMaster(
        [FakeSlave("XHD_Device", 0x0002, 0x001B), FakeSlave("Other", 0x0011, 0x0000)]
    )
    error = backend._state_transition_error(
        backend._master, EtherCatState.OP, int(EtherCatState.PRE_OP), 2_000_000
    )

    message = str(error)
    assert "State transition to OP failed" in message
    assert "XHD_Device AL status 0x0002, AL status code 0x001B" in message
    assert "SyncManager 看门狗超时" in message
    assert "Other AL status 0x0011, AL status code 0x0000" in message


def test_targeted_state_error_reports_only_target_slave() -> None:
    backend = PysoemBackend()
    first = FakeSlave("XHD_Device", 0x0002, 0x001B)
    second = FakeSlave("Other", 0x0011, 0x0000)
    backend._master = FakeMaster([first, second])
    error = backend._state_transition_error(first, EtherCatState.SAFE_OP, 0x02, 2_000_000)

    message = str(error)
    assert "XHD_Device AL status 0x0002, AL status code 0x001B" in message
    assert "Other" not in message


def test_read_states_reuses_static_scan_information(monkeypatch) -> None:
    backend = PysoemBackend()
    slave = FakeSlave("XHD_Device", 0x001B, 0)
    slave.state = int(EtherCatState.OP)
    backend._master = FakeMaster([slave])
    backend._connected = True
    cached = SlaveInfo(
        1,
        "XHD_Device",
        SlaveIdentity(0x153, 0x1234, 1, 99),
        EtherCatState.PRE_OP,
        0,
        18,
        8,
        0x1001,
        "E253",
        "LAN9253_COMPATIBLE",
    )
    backend._slaves = [cached]
    monkeypatch.setattr(backend, "_info", lambda *_: pytest.fail("static information was re-read"))

    refreshed = backend.read_states()

    assert refreshed == [
        SlaveInfo(
            1,
            "XHD_Device",
            cached.identity,
            EtherCatState.OP,
            0x001B,
            18,
            8,
            0x1001,
            "E253",
            "LAN9253_COMPATIBLE",
            raw_state=8,
        )
    ]


def test_scan_serial_uses_sii_without_optional_sdo_probe() -> None:
    class IdentitySlave:
        def eeprom_read(self, word_address: int) -> bytes:
            assert word_address == 0x0E
            return bytes.fromhex("78 56 34 12")

        def sdo_read(self, *_args, **_kwargs) -> bytes:
            pytest.fail("scan must not wait for optional CoE identity object")

    assert PysoemBackend()._serial(IdentitySlave()) == 0x12345678


def test_discovery_register_probes_use_a_short_bounded_timeout(monkeypatch) -> None:
    class ProbeSlave:
        name = "Motor"
        man = 1
        id = 2
        rev = 3
        state = int(EtherCatState.PRE_OP)
        al_status = 0
        input = b""
        output = b""

        def __init__(self) -> None:
            self.calls: list[tuple[int, int, int]] = []

        def _fprd(self, address: int, size: int, timeout_us: int) -> bytes:
            self.calls.append((address, size, timeout_us))
            raise RuntimeError("optional register unavailable")

    slave = ProbeSlave()
    backend = PysoemBackend()
    monkeypatch.setattr(backend, "_serial", lambda _: 0)

    info = backend._info(1, slave)

    assert info.name == "Motor"
    assert [call[2] for call in slave.calls] == [DISCOVERY_FPRD_TIMEOUT_US] * 6
    assert info.input_size is None and info.output_size is None
    assert info.pdi_type is None
    assert DISCOVERY_FPRD_TIMEOUT_US <= 2_000


@pytest.mark.parametrize(
    ("esc_type", "chip_id", "expected_model", "expected_family"),
    [
        (b"\x11", b"\x00\x00", "ET1100", "ET1100_COMPATIBLE"),
        (b"\x00", b"\x52\x92", "LAN9252", "LAN9252_COMPATIBLE"),
        (b"\x00", b"\x53\x92", "LAN9253", "LAN9253_COMPATIBLE"),
    ],
)
def test_discovery_uses_authoritative_esc_identification_registers(
    monkeypatch,
    esc_type: bytes,
    chip_id: bytes,
    expected_model: str,
    expected_family: str,
) -> None:
    class IdentifiedSlave:
        name = "Motor"
        man = 1
        id = 2
        rev = 3
        state = int(EtherCatState.PRE_OP)
        al_status = 0
        input = b""
        output = b""

        def __init__(self) -> None:
            self.calls: list[tuple[int, int]] = []

        def _fprd(self, address: int, size: int, timeout_us: int) -> bytes:
            self.calls.append((address, size))
            values = {
                (0x0010, 2): b"\x01\x10",
                (0x0140, 1): b"\x80",
                (0x0000, 1): esc_type,
                (0x0E02, 2): chip_id,
                (0x0004, 3): b"\x00\x00\x00",
            }
            return values[(address, size)]

    slave = IdentifiedSlave()
    backend = PysoemBackend()
    monkeypatch.setattr(backend, "_serial", lambda _: 0)

    info = backend._info(1, slave)

    assert info.chip_model == expected_model
    assert info.register_family == expected_family
    assert (0x0000, 1) in slave.calls
    if esc_type == b"\x11":
        assert (0x0E02, 2) not in slave.calls
    else:
        assert (0x0E02, 2) in slave.calls


def test_disconnect_clears_internal_state_even_when_master_close_fails() -> None:
    class BrokenMaster:
        def close(self) -> None:
            raise RuntimeError("close failed")

    backend = PysoemBackend()
    backend._master = BrokenMaster()
    backend._connected = True
    backend._mapped = True
    backend._slaves = [object()]

    with pytest.raises(RuntimeError, match="close failed"):
        backend.disconnect()

    assert backend._master is None
    assert backend.connected is False
    assert backend._mapped is False
    assert backend._slaves == []


class StateSlave:
    name = "IO"
    man, id, rev = 1, 2, 3
    al_status = 0
    input = b""
    output = b""

    def __init__(self, master, actual=2):
        self.master = master
        self.actual = self.state = actual
        self.writes = []
        self.reject_preop = False

    def write_state(self):
        self.writes.append(self.state)
        if self.state & 0x10:
            self.actual = self.state & 0x0F
            self.al_status = 0
        elif self.state == 8:
            self.actual = 4
        elif self.state == 2 and self.reject_preop:
            self.actual = 0x12
            self.al_status = 0x16
        else:
            self.actual = self.state

    def state_check(self, expected, timeout):
        if expected == 8 and self.master.exchanges >= 3:
            self.actual = 8
        self.state = self.actual
        # Match ecx_statecheck: its return value discards ErrorInd.
        return self.actual & 0x0F

    def _fprd(self, address, size, timeout):
        if address == 0x0134:
            return self.al_status.to_bytes(2, "little")
        if address == 0x0140:
            return b"\x80"
        return bytes(size)

    def eeprom_read(self, word, timeout=20000):
        raise RuntimeError("SII unavailable")

    def reconfig(self, timeout):
        return True

    def recover(self, timeout):
        return True


class StateMaster:
    manual_state_change = False
    expected_wkc = 3

    def __init__(self):
        self.slaves = [StateSlave(self)]
        self.exchanges = 0
        self.maps = 0
        self.state = 2
        self.wkc = 3

    def read_state(self):
        for slave in self.slaves:
            slave.state = slave.actual
        self.state = min(s.state for s in self.slaves)

    def write_state(self):
        for slave in self.slaves:
            slave.state = self.state
            slave.write_state()

    def state_check(self, expected, timeout):
        self.state = min(s.state_check(expected, timeout) for s in self.slaves)
        return self.state

    def config_init(self, *args, **kwargs):
        self.slaves = [StateSlave(self)]
        return 1

    def config_map(self):
        assert all(s.actual == 2 for s in self.slaves)
        assert self.manual_state_change is True
        self.maps += 1
        self.slaves[0].input = bytes(6)
        self.slaves[0].output = bytes(2)
        return 8

    def send_processdata(self, **kwargs):
        self.exchanges += 1

    def receive_processdata(self, *args, **kwargs):
        return self.wkc


def state_backend():
    backend = PysoemBackend()
    backend._master = StateMaster()
    backend._connected = True
    backend.scan()
    return backend


def test_op_wait_exchanges_until_slave_is_ready():
    backend = state_backend()
    states = backend.request_state(None, EtherCatState.OP, 100000)
    assert states[0].state is EtherCatState.OP
    assert backend._master.exchanges >= 3
    assert backend._master.maps == 2
    assert backend._master.manual_state_change is False
    assert (states[0].input_size, states[0].output_size) == (6, 2)
    assert states[0].pdo_size_source == "mapped"


def test_op_with_bad_wkc_is_not_reported_as_success():
    backend = state_backend()
    backend._master.wkc = 0
    with pytest.raises(Exception, match="WKC"):
        backend.request_state(None, EtherCatState.OP, 5000)


def test_error_ack_precedes_state_request(caplog):
    backend = state_backend()
    slave = backend._master.slaves[0]
    slave.writes.clear()
    slave.actual = 0x14
    slave.al_status = 0x1B
    backend.request_state(1, EtherCatState.PRE_OP, 1000)
    assert slave.writes == [0x14, 2]
    assert "code 0x001B" in caplog.text


def test_preop_error_bit_is_preserved_and_rejected():
    backend = state_backend()
    backend._master.slaves[0].reject_preop = True
    with pytest.raises(Exception, match="actual 0x12"):
        backend.request_state(1, EtherCatState.PRE_OP, 1000)
    state = backend.read_states()[0]
    assert state.state is EtherCatState.PRE_OP
    assert state.raw_state == 0x12


def test_init_to_op_prepares_preop_before_mapping():
    backend = state_backend()
    backend._master.slaves[0].writes.clear()
    backend._master.slaves[0].actual = 1
    backend.request_state(None, EtherCatState.OP, 100000)
    assert backend._master.slaves[0].writes[0] == 2


@pytest.mark.parametrize("operation", ["scan", "reconfig", "recover", "init"])
def test_mapping_is_rebuilt_after_configuration_invalidates_it(operation):
    backend = state_backend()
    backend.request_state(None, EtherCatState.SAFE_OP, 100000)
    if operation == "init":
        backend.request_state(None, EtherCatState.INIT, 100000)
    elif operation == "scan":
        backend.scan()
    else:
        getattr(backend, operation)(1, 1000)
    assert backend._mapped is False
    maps_before_request = backend._master.maps
    backend.request_state(None, EtherCatState.SAFE_OP, 100000)
    assert backend._master.maps == maps_before_request + 1


def test_scan_maps_pdos_keeps_live_pdi_and_finishes_in_init():
    backend = state_backend()
    assert backend._slaves[0].pdi_type == 0x80
    assert backend._master.maps == 1
    assert backend._mapped is False
    assert backend._slaves[0].state is EtherCatState.INIT
    assert (backend._slaves[0].input_size, backend._slaves[0].output_size) == (6, 2)
    assert backend._slaves[0].pdo_size_source == "cache"


def test_scan_reports_discovered_slave_before_finishing_details():
    backend = PysoemBackend()
    backend._master = StateMaster()
    backend._connected = True
    discovered = []

    final = backend.scan(discovered.append)

    assert len(discovered) == 1
    assert discovered[0][0].state is EtherCatState.PRE_OP
    assert discovered[0][0].configured_address is None
    assert final[0].state is EtherCatState.INIT


def test_sii_scan_reads_declared_sm_sizes_without_mailbox():
    image = bytearray(256)
    image[0x7C:0x7E] = (1).to_bytes(2, "little")
    image[0x80:0x84] = bytes.fromhex("29 00 10 00")
    image[0x84:0xA4] = bytes.fromhex(
        "00 10 80 00 26 00 01 01 80 10 80 00 22 00 01 02 "
        "00 11 02 00 64 00 01 03 00 14 06 00 20 00 01 04"
    )

    class EepromSlave:
        def eeprom_read(self, word, timeout):
            assert timeout == DISCOVERY_FPRD_TIMEOUT_US
            return bytes(image[word * 2:word * 2 + 4])

    assert PysoemBackend()._sii_pdo_sizes(EepromSlave()) == (6, 2)
    image[0x82:0x84] = bytes.fromhex("FF FF")
    assert PysoemBackend()._sii_pdo_sizes(EepromSlave()) == (None, None)


def test_sii_scan_reads_product_names_and_sm_size_fallback():
    image = bytearray(b"\xff" * 512)
    image[0x7C:0x7E] = (3).to_bytes(2, "little")
    offset = 0x80

    def category(kind, data):
        nonlocal offset
        payload = bytes(data)
        payload += bytes(len(payload) % 2)
        image[offset : offset + 4] = (
            kind.to_bytes(2, "little") + (len(payload) // 2).to_bytes(2, "little")
        )
        image[offset + 4 : offset + 4 + len(payload)] = payload
        offset += 4 + len(payload)

    names = ("XHD_Device", "XHD_CAN_Motor_18*8", "XHD_Device")
    category(
        0x000A,
        bytes([len(names)])
        + b"".join(bytes([len(name)]) + name.encode("ascii") for name in names),
    )
    general = bytearray(32)
    general[0:4] = bytes([1, 0, 2, 3])
    category(0x001E, general)
    category(
        0x0029,
        bytes.fromhex(
            "00 10 80 00 26 00 01 01 80 10 80 00 22 00 01 02 "
            "00 11 E2 00 64 00 01 03 00 14 E8 00 20 00 01 04"
        ),
    )
    image[offset : offset + 2] = b"\xff\xff"

    class EepromSlave:
        def eeprom_read(self, word, timeout):
            return bytes(image[word * 2 : word * 2 + 4])

    assert PysoemBackend()._sii_discovery_info(EepromSlave()) == (
        232,
        226,
        "XHD_Device",
        "XHD_CAN_Motor_18*8",
    )


def test_mapping_keeps_sii_sizes_when_pysoem_buffers_are_empty():
    class ZeroMapMaster(StateMaster):
        def config_map(self):
            self.maps += 1
            self.slaves[0].input = b""
            self.slaves[0].output = b""
            return 0

    backend = PysoemBackend()
    backend._master = ZeroMapMaster()
    backend._connected = True
    backend._slaves = [
        SlaveInfo(
            1,
            "Motor",
            SlaveIdentity(1, 2, 3),
            EtherCatState.PRE_OP,
            0,
            232,
            226,
            pdo_size_source="sii",
        )
    ]

    backend.map_process_data()

    assert (backend._slaves[0].input_size, backend._slaves[0].output_size) == (232, 226)
    assert backend._slaves[0].pdo_size_source == "sii"


def test_example_slave_sii_declares_six_input_and_two_output_bytes(workspace):
    from ethercat_debug_tool.esi.parser import EsiParser
    from ethercat_debug_tool.sii.generator import SiiGenerator

    device = EsiParser().parse(
        workspace / "示例从站" / "F28335_LAN9252_ECAT_IO" / "E252-EVB-SPI.xml"
    ).devices[0]
    image = SiiGenerator().generate(device).image

    class ExampleSlave:
        def eeprom_read(self, word, timeout):
            return image[word * 2:word * 2 + 4]

    assert PysoemBackend()._sii_pdo_sizes(ExampleSlave()) == (6, 2)


def test_failed_rescan_clears_old_mapping_and_topology(monkeypatch):
    backend = state_backend()
    backend.request_state(None, EtherCatState.SAFE_OP, 100000)

    def failed(*args, **kwargs):
        raise RuntimeError("link lost")

    monkeypatch.setattr(backend._master, "config_init", failed)
    with pytest.raises(Exception, match="link lost"):
        backend.scan()
    assert backend._mapped is False
    assert backend._slaves == []


def test_failed_error_ack_does_not_attempt_requested_state(monkeypatch):
    backend = state_backend()
    slave = backend._master.slaves[0]
    slave.writes.clear()
    slave.actual = 0x14
    monkeypatch.setattr(slave, "state_check", lambda *args: 0x14)
    with pytest.raises(Exception, match="actual 0x14"):
        backend.request_state(1, EtherCatState.PRE_OP, 1000)
    assert slave.writes == [0x14]


def test_worker_setup_remaps_once_and_keeps_pdo_exchange_in_op_wait():
    from ethercat_debug_tool.worker.ethercat_worker import EtherCatWorker

    backend = state_backend()
    EtherCatWorker._configure_cycle(backend, 5, 2000, 5)
    assert backend._master.maps == 2
    assert backend._master.exchanges >= 3
