import struct
import threading
from dataclasses import replace

import pytest

from ethercat_debug_tool.backends.base import CommunicationError
from ethercat_debug_tool.backends.passive_discovery import NpcapEthercatTransport
from ethercat_debug_tool.bridge import BridgeRuntime
from ethercat_debug_tool.models import BackendMode
from ethercat_debug_tool.services.register_service import RegisterService


def response_frame(request, requests, wkcs):
    """Model the traversal changes and independent datagram counters."""
    response = bytearray(request)
    offset = 16
    for (_, size), wkc in zip(requests, wkcs, strict=True):
        struct.pack_into("<H", response, offset + 2, 1)
        response[offset + 10:offset + 10 + size] = bytes([0xA5]) * size
        struct.pack_into("<H", response, offset + 10 + size, wkc)
        offset += size + 12
    return bytes(response)


def test_multiple_reads_have_individual_wkc_and_a_final_datagram():
    requests = [(0x10, 2), (0x130, 2), (0x900, 8)]
    frame = NpcapEthercatTransport._read_frame(1, 16, 0, requests, b"\x02" * 6)
    assert struct.unpack_from("<H", frame, 22)[0] == 0x8002
    response = response_frame(frame, requests, [1, 0, 1])
    assert NpcapEthercatTransport._read_response(response, frame, requests) == [
        (b"\xA5" * 2, 1), (b"\xA5" * 2, 0), (b"\xA5" * 8, 1)
    ]


@pytest.mark.parametrize("damage", ["index", "address", "length", "more", "truncate", "header"])
def test_mismatched_or_partial_frames_never_expose_register_data(damage):
    requests = [(0x10, 2), (0x130, 2)]
    frame = NpcapEthercatTransport._read_frame(1, 16, 0, requests, b"\x02" * 6)
    response = bytearray(response_frame(frame, requests, [1, 1]))
    offset = 30
    if damage == "index":
        response[offset + 1] += 1
    elif damage == "address":
        response[offset + 4] += 1
    elif damage == "length":
        response[offset + 6] += 1
    elif damage == "more":
        response[offset + 7] |= 0x80
    elif damage == "truncate":
        response = response[:43]
    else:
        response[14] += 1
    assert NpcapEthercatTransport._read_response(bytes(response), frame, requests) is None


def test_read_planning_obeys_payload_and_datagram_budgets():
    requests = [(address, 256) for address in range(0, 8192, 256)]
    frames = RegisterService.read_frames(requests)
    assert [item for frame in frames for item in frame] == requests
    assert all(len(frame) <= 15 and sum(size + 12 for _, size in frame) <= 1498 for frame in frames)
    assert len(RegisterService.read_frames([(address, 1) for address in range(31)])) == 3


class Writer:
    def event(self, *_args):
        pass


@pytest.fixture
def runtime():
    core = BridgeRuntime(Writer(), BackendMode.DEMO)
    core.dispatch("auto_scan", {"preferred_adapter": "demo0"})
    yield core
    core.shutdown()


def test_snapshot_expands_actual_channels_and_does_not_ack_events(runtime, monkeypatch):
    backend = runtime.worker._backend
    backend._registers[1][4:6] = bytes([8, 8])
    calls = []
    original = backend.register_read_many

    def read(position, requests, timeout):
        calls.extend(requests)
        return original(position, requests, timeout)

    monkeypatch.setattr(backend, "register_read_many", read)
    result = runtime.dispatch("register_snapshot", {"request_id": "all", "position": 2, "profile": "E252", "all": True})
    assert any(item["address"] == 0x067C for item in result["catalog"])
    assert any(item["address"] == 0x083F for item in result["catalog"])
    assert (0x0130, 2) not in calls
    assert (0x0110, 2) not in calls
    assert (0x0440, 2) not in calls
    assert (0x0144, 1) not in calls
    assert len(calls) > result["frame_count"] * 5
    definition = next(item for item in result["catalog"] if item["address"] == 0x083F)
    assert runtime.dispatch("register_definition", {"position": 2, "profile": "E252", "definition_id": definition["definition_id"]})["fields"]


# Manual reads remain available when a register acknowledges an event.
def test_acknowledgement_register_can_be_read_only_by_explicit_request(runtime, monkeypatch):
    definition = runtime.profiles.find("LAN9252", "esc_core", 0x0440)
    calls = []
    backend = runtime.worker._backend
    original = backend.register_read_many

    def read(position, requests, timeout):
        calls.extend(requests)
        return original(position, requests, timeout)

    monkeypatch.setattr(backend, "register_read_many", read)
    request = {"definition_id": definition["definition_id"], "address": 0x0440, "size": 2}
    automatic = runtime.dispatch("register_snapshot", {"request_id": "auto-ack", "position": 2, "profile": "LAN9252", "automatic": True, "requests": [request]})
    assert not calls and automatic["skipped"][definition["definition_id"]] == "需手动读取"
    manual = runtime.dispatch("register_snapshot", {"request_id": "manual-ack", "position": 2, "profile": "LAN9252", "requests": [request]})
    assert calls == [(0x0440, 2)] and len(manual["values"]) == 1


# Memory windows stay bounded and cannot alias local-only CSR offsets.
def test_memory_window_reads_use_the_absolute_ethercat_range(runtime):
    catalog = runtime.profiles.catalog("LAN9252")
    memory = [item for item in catalog if item["address_space"] == "process_ram"]
    assert [(item["address"], item["width"]) for item in memory] == [(address, 4) for address in range(0x1000, 0x2000, 4)]
    definition = runtime.profiles.find("LAN9252", "user_ram", 0x0F80)
    assert definition["width"] == 128 and definition["requires_manual_read"]
    result = runtime.dispatch("register_read", {"position": 2, "profile": "LAN9252", "definition_id": definition["definition_id"], "address": 0x0F80, "size": 128})
    assert result.address == 0x0F80 and len(result.data) == 128


def test_one_register_failure_does_not_discard_successful_datagrams(runtime, monkeypatch):
    backend = runtime.worker._backend
    original = backend.register_read_many

    def read(position, requests, timeout):
        return [replace(value, wkc=0) if value.address == 0x10 else value for value in original(position, requests, timeout)]

    monkeypatch.setattr(backend, "register_read_many", read)
    result = runtime.dispatch("register_snapshot", {"request_id": "partial", "position": 1, "all": True})
    assert any("0x0010" in message and "WKC=0" in message for message in result["errors"].values())
    assert any(value.address == 0x134 for value in result["values"])
    assert not any(value.address == 0x10 for value in result["values"])


def test_frame_fault_preserves_earlier_values_and_stops_new_frames(runtime, monkeypatch):
    backend = runtime.worker._backend
    original = backend.register_read_many
    calls = 0

    def read(position, requests, timeout):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise CommunicationError("link lost")
        return [replace(value, wkc=0) if value.address == 0x10 else value
                for value in original(position, requests, timeout)]

    monkeypatch.setattr(backend, "register_read_many", read)
    result = runtime.dispatch("register_snapshot", {"request_id": "fault", "position": 1, "all": True})
    assert calls == 3
    assert result["values"] and result["errors"]
    assert result["error"] == "link lost"
    assert any("0x0010" in message and "WKC=0" in message for message in result["errors"].values())


def test_cancel_during_a_frame_stops_at_the_frame_boundary(runtime, monkeypatch):
    backend = runtime.worker._backend
    original = backend.register_read_many
    entered = threading.Event()
    release = threading.Event()
    calls = 0
    result = {}

    def read(position, requests, timeout):
        nonlocal calls
        calls += 1
        if calls == 2:
            entered.set()
            release.wait(2)
        return original(position, requests, timeout)

    monkeypatch.setattr(backend, "register_read_many", read)

    def acquire():
        result.update(runtime.dispatch("register_snapshot", {"request_id": "cancel", "position": 1, "all": True}))

    thread = threading.Thread(target=acquire)
    thread.start()
    try:
        assert entered.wait(1)
        runtime.dispatch("register_cancel", {"request_id": "cancel"})
        release.set()
        thread.join(2)
        assert not thread.is_alive()
        assert result["cancelled"] and calls == 2
        assert "cancel" not in runtime._register_jobs
    finally:
        release.set()
        thread.join(2)
