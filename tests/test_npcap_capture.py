import ctypes
import os
from pathlib import Path

import pytest

from ethercat_debug_tool.backends.passive_discovery import (
    PASSIVE_INDEX_MAX,
    NpcapEthercatTransport,
    PassiveDiscoveryError,
    _BpfProgram,
    _PcapPacketHeader,
)


class CaptureLibrary:
    """Model setup failures without opening a physical network adapter."""

    def __init__(self, failure=None):
        self.failure = failure
        self.closed = []
        self.freed = 0
        self.filters = []
        self.open_timeouts = []

    def pcap_open_live(self, name, snaplen, promisc, timeout, error):
        self.open_timeouts.append(timeout)
        return 123

    def pcap_setmintocopy(self, handle, minimum):
        assert minimum == 0
        return -1 if self.failure == "delivery" else 0

    def pcap_compile(self, handle, program, expression, optimize, netmask):
        self.filters.append(expression)
        return -1 if self.failure == "compile" else 0

    def pcap_setfilter(self, handle, program):
        return -1 if self.failure == "filter" else 0

    def pcap_freecode(self, program):
        self.freed += 1

    def pcap_geterr(self, handle):
        return b"capture setup failed"

    def pcap_close(self, handle):
        self.closed.append(handle.value)


# Native setup errors must release handles and surface the original failure.
@pytest.mark.parametrize("failure", ["delivery", "compile", "filter"])
def test_capture_setup_failure_releases_native_resources(failure):
    channel = NpcapEthercatTransport("mock")
    library = CaptureLibrary(failure)
    channel._pcap = library
    with pytest.raises(PassiveDiscoveryError, match="capture setup failed"):
        channel.open()
    assert library.closed == [123]
    assert not channel._handle.value
    assert library.freed == (1 if failure == "filter" else 0)


# Reopening must preserve the filtered channel without duplicating native handles.
def test_capture_open_sets_low_latency_filter_once():
    channel = NpcapEthercatTransport("mock")
    library = CaptureLibrary()
    channel._pcap = library
    channel.open()
    channel.open()
    assert library.open_timeouts == [1]
    assert library.filters == [
        f"ether proto 0x88a4 and ether src {channel._source.hex(':')}".encode("ascii"),
    ]
    assert library.freed == 1
    channel.close()
    assert library.closed == [123]


# A failed filter refresh must not advance the source/index or send any frame.
@pytest.mark.parametrize("method", ["exchange", "read_many"])
def test_filter_refresh_failure_keeps_channel_generation(method, monkeypatch):
    channel = NpcapEthercatTransport("mock")
    library = CaptureLibrary("filter")
    channel._pcap = library
    channel._index = PASSIVE_INDEX_MAX
    source = channel._source
    monkeypatch.setattr(channel, "open", lambda: None)
    with pytest.raises(PassiveDiscoveryError, match="capture setup failed"):
        if method == "exchange":
            channel.exchange(1, 0, 0, 0x0130, bytes(2))
        else:
            channel.read_many(1, 0, [(0x0130, 2)])
    assert channel._index == PASSIVE_INDEX_MAX
    assert channel._source == source
    assert library.freed == 1


# Use Npcap's real BPF compiler/interpreter to check the ABI and packet selection.
@pytest.mark.skipif(os.name != "nt", reason="Npcap native API requires Windows")
def test_native_filter_accepts_only_current_channel_ethercat(monkeypatch):
    dll_path = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/Npcap/wpcap.dll"
    if not dll_path.is_file():
        pytest.skip("Npcap is not installed")
    load_library = ctypes.WinDLL
    monkeypatch.setattr(ctypes, "WinDLL", lambda name: load_library(str(dll_path)))
    channel = NpcapEthercatTransport("offline")
    library = channel._load()
    library.pcap_open_dead.argtypes = [ctypes.c_int, ctypes.c_int]
    library.pcap_open_dead.restype = ctypes.c_void_p
    library.pcap_offline_filter.argtypes = [
        ctypes.POINTER(_BpfProgram), ctypes.POINTER(_PcapPacketHeader), ctypes.POINTER(ctypes.c_ubyte),
    ]
    library.pcap_offline_filter.restype = ctypes.c_uint
    handle = library.pcap_open_dead(1, 65535)  # DLT_EN10MB; no adapter or packets are transmitted.
    assert handle
    native_setfilter = library.pcap_setfilter
    sources = []

    # Evaluate the compiled filter while its native instruction storage is alive.
    def evaluate_filter(capture_handle, program):
        sources.append(channel._source)
        frame = channel._read_frame(1, 16, 0, [(0x0130, 2), (0x0502, 2)], channel._source)
        other_source = bytearray(frame)
        other_source[7] ^= 1
        other_protocol = bytearray(frame)
        other_protocol[12:14] = b"\x08\x00"
        for packet, accepted in [(frame, True), (other_source, False), (other_protocol, False)]:
            header = _PcapPacketHeader(caplen=len(packet), length=len(packet))
            buffer = (ctypes.c_ubyte * len(packet)).from_buffer_copy(packet)
            assert bool(library.pcap_offline_filter(program, ctypes.byref(header), buffer)) is accepted
        return 0

    try:
        # An offline handle cannot install filters, so intercept only that final step.
        library.pcap_setfilter = evaluate_filter
        channel._handle = ctypes.c_void_p(handle)
        channel._set_capture_filter(channel._source)
        old_source = channel._source
        channel._source = b"\x02" + bytes(byte ^ 1 for byte in old_source[1:])
        channel._set_capture_filter(channel._source)
        assert len(sources) == 2 and sources[0] != sources[1]
    finally:
        library.pcap_setfilter = native_setfilter
        channel.close()
