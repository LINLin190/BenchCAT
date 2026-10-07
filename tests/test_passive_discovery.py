import ctypes
import struct

import pytest

from ethercat_debug_tool.backends.passive_discovery import (
    NpcapEthercatTransport,
    PassiveDiscoveryError,
    PassiveMediaDisconnected,
    _PcapPacketHeader,
    _sii_summary,
    discover,
)
from ethercat_debug_tool.sii.generator import SiiGenerator
from ethercat_debug_tool.sii.parser import inspect_sii_header, validate_eeprom_range


class DiscoveryTransport:
    def __init__(self, image):
        self.image = image
        self.reads = []
        self.eeprom_reads = []
        self.failed_address = None
        self.registers = {
            0x0000: b"\x11\x00", 0x0130: b"\x08\x00", 0x0134: bytes(2),
            0x0010: bytes(2), 0x0140: b"\x05", 0x0005: b"\x03", 0x0502: b"\xC0\x00",
            0x0E00: b"\x4C\x24" + bytes(6),
            # Nonstandard placement/direction: SM0 IN, SM1 OUT, SM2 mailbox.
            0x0800: b"".join(struct.pack("<HHBBBB", 0x1000 + i * 256, size, control, 0, 1, 0)
                             for i, (size, control) in enumerate([(232, 0x20), (226, 0x24), (128, 0x26)])),
        }

    def open(self):
        pass

    def brd(self, address, size):
        return bytes(size), 1

    def aprd(self, position, address, size):
        assert position == 1
        self.reads.append(address)
        return (bytes(size), 0) if address == self.failed_address else (self.registers[address], 1)

    def eeprom_read(self, position, word, count):
        self.eeprom_reads.append((word, count))
        return self.image[word * 2:(word + count) * 2]


def test_discovery_uses_live_sm_and_never_writes_al_or_configuration(sample_esi):
    channel = DiscoveryTransport(SiiGenerator().generate(sample_esi.devices[0]).image)
    info, = discover("mock", transport=channel)
    assert info.state == 8 and info.configured_address == 0
    assert (info.sm_input_size, info.sm_output_size) == (232, 226)
    assert info.sii_status == "header_valid" and info.identity_valid
    assert info.eeprom_capacity == 2048
    assert 0x0E02 not in channel.reads and 0x0E00 in channel.reads
    assert info.esc_hardware == b"\x4C\x24" + bytes(6)
    assert channel.eeprom_reads == [(0, 64), (0x40, 256)]


@pytest.mark.parametrize("fill", [0, 255])
def test_blank_eeprom_keeps_esc_and_state_access(fill):
    channel = DiscoveryTransport(bytes([fill]) * 2048)
    info, = discover("mock", transport=channel)
    assert info.state == 8 and info.sii_status == "blank"
    assert info.eeprom_capacity is None and not info.identity_valid
    assert info.eeprom_prefix == bytes([fill]) * 16
    assert channel.eeprom_reads == [(0, 64)]


def test_optional_wkc_failure_is_not_a_real_zero(sample_esi):
    channel = DiscoveryTransport(SiiGenerator().generate(sample_esi.devices[0]).image)
    channel.failed_address = 0x0800
    info, = discover("mock", transport=channel)
    assert info.sm_input_size is None and info.sm_output_size is None
    assert any("0x0800" in error and "WKC=0" in error for error in info.scan_errors)
    channel.failed_address = 0x0000
    with pytest.raises(PassiveDiscoveryError, match="0x0000"):
        discover("mock", transport=channel)


def test_missing_eeprom_does_not_hide_slave():
    channel = DiscoveryTransport(b"")
    info, = discover("mock", transport=channel)
    assert info.state == 8 and info.sii_status == "unreadable"
    assert info.eeprom_prefix_error and info.eeprom_capacity is None


def test_link_failure_is_not_an_empty_success(monkeypatch):
    channel = DiscoveryTransport(b"")

    def disconnected(*args):
        raise PassiveMediaDisconnected("网卡链路未连接")

    monkeypatch.setattr(channel, "brd", disconnected)
    with pytest.raises(PassiveMediaDisconnected):
        discover("mock", transport=channel)


@pytest.mark.parametrize("offset,value", [(0, 0xFF), (0x7C, 0xFFFF), (0x7E, 0)])
def test_invalid_header_never_drives_unbounded_capacity(sample_esi, offset, value):
    raw = bytearray(SiiGenerator().generate(sample_esi.devices[0]).image)
    raw[offset:offset + 2] = value.to_bytes(2, "little")
    header = inspect_sii_header(raw[:128])
    assert header.status == "invalid" and header.error
    assert header.capacity is None and not header.identity_valid


@pytest.mark.parametrize("word,size", [(-1, 2), (0, 0), (0, 3), (0x10000, 2), (0, 131074)])
def test_raw_eeprom_range_rejects_invalid_values(word, size):
    with pytest.raises(ValueError):
        validate_eeprom_range(word, size)


def test_sii_category_bounds_and_strings_are_checked():
    with pytest.raises(ValueError, match="超出声明容量"):
        _sii_summary(struct.pack("<HH", 10, 0xFFFF), 2048)
    with pytest.raises(ValueError, match="String"):
        _sii_summary(struct.pack("<HH", 10, 1) + b"\x01\x20", 2048)
    with pytest.raises(ValueError, match="缺少结束标记"):
        _sii_summary(bytes(128), 256)
    # A scan prefix may end in a category whose remainder was intentionally not read.
    assert _sii_summary(struct.pack("<HH", 10, 50), 2048) == (None, None)


@pytest.mark.parametrize("offset", [6, 14, 16, 17, 20, 22, 23])
def test_response_rejects_wrong_channel_index_address_or_length(offset):
    request = NpcapEthercatTransport._frame(1, 42, 0, 0x0502, bytes(2))
    response = bytearray(request)
    struct.pack_into("<H", response, 18, 1)  # Auto-increment ADP changes in transit.
    struct.pack_into("<H", response, 28, 1)
    assert NpcapEthercatTransport._response(bytes(response), request, 1, 42, 2) == (bytes(2), 1)
    response[offset] ^= 0x80 if offset == 23 else 1
    assert NpcapEthercatTransport._response(bytes(response), request, 1, 42, 2) is None


def test_matching_response_preserves_zero_wkc():
    request = NpcapEthercatTransport._frame(1, 7, 0, 0x0502, bytes(2))
    response = bytearray(request)
    struct.pack_into("<H", response, 18, 1)
    assert NpcapEthercatTransport._response(bytes(response), request, 1, 7, 2) == (bytes(2), 0)


# Both receive paths must reject old replies after refreshing the source filter.
@pytest.mark.parametrize("method", ["aprd", "read_many"])
def test_passive_indices_never_overlap_soem_and_wrap_rejects_old_response(monkeypatch, method):
    nonce = iter(bytes([value]) * 5 for value in range(10))
    monkeypatch.setattr("ethercat_debug_tool.backends.passive_discovery.secrets.token_bytes",
                        lambda size: next(nonce))
    channel = NpcapEthercatTransport("mock")
    monkeypatch.setattr(channel, "open", lambda: None)
    filters = []
    monkeypatch.setattr(channel, "_set_capture_filter", filters.append)
    requests = []
    responses = []
    old_response = None

    class Pcap:
        def pcap_sendpacket(self, handle, buffer, size):
            nonlocal old_response
            request = bytes(buffer)
            requests.append(request)
            response = bytearray(request)
            struct.pack_into("<H", response, 18, 1)
            struct.pack_into("<H", response, 26, len(requests))
            struct.pack_into("<H", response, 28, 1)
            if len(requests) == 1:
                old_response = bytes(response)
            if len(requests) == 241:
                responses.append(old_response)
            responses.append(bytes(response))
            return 0

        def pcap_next_ex(self, handle, header_out, packet_out):
            response = responses.pop(0)
            self.header = _PcapPacketHeader(caplen=len(response), length=len(response))
            self.packet = (ctypes.c_ubyte * len(response)).from_buffer_copy(response)
            ctypes.cast(header_out, ctypes.POINTER(ctypes.POINTER(_PcapPacketHeader)))[0] = ctypes.pointer(self.header)
            ctypes.cast(packet_out, ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)))[0] = ctypes.cast(
                self.packet, ctypes.POINTER(ctypes.c_ubyte),
            )
            return 1

    channel._pcap = Pcap()
    for sequence in range(1, 481):
        reply = channel.aprd(1, 0x0130, 2) if method == "aprd" else channel.read_many(1, 0, [(0x0130, 2)])[0]
        assert reply == (sequence.to_bytes(2, "little"), 1)
    assert [request[17] for request in requests] == list(range(16, 256)) * 2
    assert requests[0][6:12] != requests[240][6:12]
    assert filters == [requests[240][6:12]]
    assert responses == []
