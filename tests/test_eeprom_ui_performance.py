from concurrent.futures import ThreadPoolExecutor

import pytest

from ethercat_debug_tool.bridge import BridgeRuntime
from ethercat_debug_tool.esi import EsiParser
from ethercat_debug_tool.models import BackendMode, OperationProgress


# Record telemetry without creating a transport or touching physical devices.
class ProgressWriter:
    def __init__(self):
        self.events = []

    def event(self, kind, payload, session_id=None):
        self.events.append((kind, payload, session_id))


# Every case owns a short-lived demo runtime and its local audit output.
@pytest.fixture
def runtime(tmp_path):
    value = BridgeRuntime(ProgressWriter(), BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")
    try:
        yield value
    finally:
        value.shutdown()


# A burst of word updates preserves both stage boundaries and the final count.
def test_progress_coalesces_word_bursts_and_keeps_boundaries(runtime, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("ethercat_debug_tool.bridge.time.monotonic", lambda: clock[0])
    runtime._progress(OperationProgress("eeprom-flash", "write-verify", 0, 32768))
    for completed in range(1, 32768):
        runtime._progress(OperationProgress("eeprom-flash", "write-verify", completed, 32768))
    clock[0] += 0.11
    runtime._progress(OperationProgress("eeprom-flash", "write-verify", 32767, 32768))
    runtime._progress(OperationProgress("eeprom-flash", "write-verify", 32768, 32768))
    runtime._progress(OperationProgress("eeprom-flash", "full-verify", 128, 65536))
    events = [payload for kind, payload, _ in runtime.writer.events if kind == "progress"]
    assert [(item.stage, item.completed) for item in events] == [
        ("write-verify", 0), ("write-verify", 32767),
        ("write-verify", 32768), ("full-verify", 128),
    ]
    runtime._active_hardware_session = 99
    runtime._progress(OperationProgress("eeprom-flash", "full-verify", 256, 65536))
    assert runtime.writer.events[-1][2] == 99
    runtime._progress(OperationProgress("eeprom-read", "read", 128, 2048))
    assert runtime.writer.events[-1][1].operation == "eeprom-read"


# Unchanged XML, including failures, is parsed once across concurrent listings.
def test_library_reuses_parse_results_and_refreshes_errors(runtime, tmp_path, monkeypatch):
    source = tmp_path / "broken.xml"
    source.write_text("<broken>", encoding="utf-8")
    original = EsiParser.parse
    calls = []

    def counted(parser, path):
        calls.append(path)
        return original(parser, path)

    monkeypatch.setattr(EsiParser, "parse", counted)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: runtime.dispatch("esi_library_list", {"directory": str(tmp_path)}), range(2)))
    assert len(calls) == 1
    assert results[0] == results[1] and len(results[0]["errors"]) == 1
    runtime.dispatch("esi_library_list", {"directory": str(tmp_path), "refresh": True})
    assert len(calls) == 2


# Cached list metadata never becomes a frozen programming target.
def test_library_detects_edits_deletions_and_loads_fresh_bin(runtime, tmp_path):
    source = tmp_path / "source.bin"
    source.write_bytes(b"\x01\x02")
    first = runtime.dispatch("esi_library_list", {"directory": str(tmp_path)})["entries"][0]
    source.write_bytes(b"\x03\x04\x05")
    second = runtime.dispatch("esi_library_list", {"directory": str(tmp_path)})["entries"][0]
    assert second["byte_size"] == 3 and second["sha256"] != first["sha256"]
    source.write_bytes(b"\x06\x07")
    target = runtime.dispatch("eeprom_bin_load", {"path": str(source)})
    assert runtime.dispatch("eeprom_target_data", {"target_id": target["target_id"]})["data"] == b"\x06\x07"
    source.unlink()
    assert runtime.dispatch("esi_library_list", {"directory": str(tmp_path)})["entries"] == []
    assert source not in runtime._library_cache


# Explicit ConfigData saves invalidate list metadata independently of timestamps.
def test_config_save_invalidates_library_cache(runtime, tmp_path):
    source = tmp_path / "source.xml"
    source.write_text(
        '<EtherCATInfo><Vendor><Id>2</Id></Vendor><Descriptions><Devices>'
        '<Device><Type ProductCode="1" RevisionNo="1">Device</Type>'
        '<Eeprom><ByteSize>2048</ByteSize><ConfigData>050E</ConfigData></Eeprom>'
        '</Device></Devices></Descriptions></EtherCATInfo>', encoding="utf-8",
    )
    runtime.dispatch("esi_library_list", {"directory": str(tmp_path)})
    assert source in runtime._library_cache
    loaded = runtime.dispatch("esi_load", {"path": str(source)})
    runtime.dispatch("esi_config_save", {"document_id": loaded["document_id"], "ordinal": 0, "config_data": "80 0E"})
    assert source not in runtime._library_cache
    refreshed = runtime.dispatch("esi_library_list", {"directory": str(tmp_path)})
    assert refreshed["entries"][0]["config_data"] == b"\x80\x0e"


# Metadata cache eviction bounds memory while listings still include every file.
def test_library_cache_is_bounded(runtime, tmp_path, monkeypatch):
    monkeypatch.setattr("ethercat_debug_tool.bridge.MAX_STORED_LIBRARY_SOURCES", 2)
    for index in range(4):
        (tmp_path / f"{index}.bin").write_bytes(bytes([index]))
    result = runtime.dispatch("esi_library_list", {"directory": str(tmp_path)})
    assert len(result["entries"]) == 4
    assert len(runtime._library_cache) == 2
