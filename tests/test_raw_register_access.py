from unittest.mock import Mock

import pytest

from ethercat_debug_tool.backends.pysoem_backend import PysoemBackend
from ethercat_debug_tool.models import RegisterRead
from ethercat_debug_tool.services.register_service import RegisterService


# A non-unit write counter must never suppress or duplicate the following read.
@pytest.mark.parametrize("write_wkc", [0, 1, 2, 65535])
def test_raw_write_reads_once_for_every_counter(write_wkc):
    backend = Mock()
    calls = []

    def write(position, address, data, timeout_us):
        calls.append(("write", position, address, data))
        return write_wkc

    def read(position, requests, timeout_us):
        calls.append(("read", position, requests))
        return [RegisterRead(position, 0x0002, b"\x34\x12", 1, 0, 0)]

    backend.register_write_raw.side_effect = write
    backend.register_read_many.side_effect = read
    result = RegisterService(backend).write_raw(1, 0x0002, b"\x34\x12")
    assert result.write_wkc == write_wkc
    assert result.readback.data == b"\x34\x12"
    assert calls == [("write", 1, 0x0002, b"\x34\x12"), ("read", 1, [(0x0002, 2)])]
    backend.register_read.assert_not_called()


# Readback failures remain separate from a completed write, including WKC zero.
def test_raw_write_preserves_independent_write_and_read_errors():
    backend = Mock()
    backend.register_write_raw.side_effect = RuntimeError("write timeout")
    backend.register_read_many.side_effect = RuntimeError("read timeout")
    result = RegisterService(backend).write_raw(1, 0xFFFF, b"\x12")
    assert result.write_wkc is None and result.readback is None
    assert result.write_error == "write timeout" and result.read_error == "read timeout"
    backend.register_read_many.assert_called_once_with(1, [(0xFFFF, 1)], 2000)


# Invalid ranges must not send either transaction to the device.
def test_raw_write_rejects_overflow_before_device_access():
    backend = Mock()
    with pytest.raises(ValueError):
        RegisterService(backend).write_raw(1, 0xFFFF, b"\x12\x34")
    assert backend.mock_calls == []


# A read WKC of zero must survive the bridge instead of becoming a fabricated one.
def test_raw_read_preserves_zero_counter():
    backend = Mock()
    backend.register_read_many.return_value = [RegisterRead(1, 0x0040, b"\x00", 0, 0, 0)]
    result = RegisterService(backend).read_raw(1, 0x0040, 1)
    assert result.wkc == 0


# The real raw transport must expose APWR WKC without the ordinary write guard.
@pytest.mark.parametrize("write_wkc", [0, 2])
def test_raw_backend_exposes_non_unit_counter(write_wkc):
    backend = PysoemBackend()
    backend._master, backend._connected = object(), True
    backend._slaves = [Mock()]
    backend._passive = Mock()
    backend._passive.write.return_value = write_wkc
    assert backend.register_write_raw(1, 0x0002, b"\x34\x12", 2000) == write_wkc
    backend._passive.write.assert_called_once_with(0x02, 0, 0x0002, b"\x34\x12")
