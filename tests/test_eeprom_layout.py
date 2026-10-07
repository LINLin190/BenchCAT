import io

from ethercat_debug_tool.bridge import BridgeRuntime, JsonWriter
from ethercat_debug_tool.models import BackendMode
from ethercat_debug_tool.sii.generator import SiiGenerator
from ethercat_debug_tool.sii.layout import image_layout
from ethercat_debug_tool.sii.parser import SiiParser


# SII navigation addresses include category headers and the two-byte end marker.
def test_layout_matches_parsed_category_ranges(sample_esi):
    raw = SiiGenerator().generate(sample_esi.devices[0]).image
    parsed = SiiParser().parse(raw)
    result = image_layout(raw)
    assert result["layout_error"] is None
    categories = result["layout"][5:-1]
    assert [(s["kind"], s["offset"], s["length"]) for s in categories] == [
        (c.kind, c.offset, len(c.payload) + 4) for c in parsed.categories
    ]
    assert result["layout"][-1]["offset"] == parsed.end_offset
    assert result["layout"][-1]["length"] == 2
    partial = image_layout(raw[:parsed.end_offset + 2])
    assert partial == result


# Truncated or arbitrary BIN data exposes only fields actually present in the snapshot.
def test_short_and_invalid_images_keep_bounded_fixed_fields():
    for raw in [b"", b"\xff" * 9, b"\xff" * 129, bytes(2048)]:
        result = image_layout(raw)
        assert result["layout_error"]
        assert all(0 <= s["offset"] < s["offset"] + s["length"] <= len(raw) for s in result["layout"])
        assert all(s["kind"] is None for s in result["layout"])


# Target browsing serves the frozen bytes even if the selected file changes on disk.
def test_target_snapshot_does_not_reopen_source_or_access_worker(tmp_path):
    source = tmp_path / "target.bin"
    original = bytes(range(255))
    source.write_bytes(original)
    runtime = BridgeRuntime(JsonWriter(io.BytesIO()), BackendMode.DEMO, audit_path=tmp_path / "audit.jsonl")
    try:
        target = runtime.dispatch("eeprom_bin_load", {"path": str(source)})
        source.write_bytes(b"changed")
        runtime._submit = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("hardware access"))
        snapshot = runtime.dispatch("eeprom_target_data", {"target_id": target["target_id"]})
        assert snapshot["data"] == original
        assert snapshot["sha256"] == target["sha256"]
        assert snapshot["size"] == 255
    finally:
        runtime.shutdown()
