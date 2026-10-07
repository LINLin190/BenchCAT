from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest

from ethercat_debug_tool.bridge import BridgeRuntime
from ethercat_debug_tool.esc_profiles.profiles import ProfileRegistry
from ethercat_debug_tool.models import BackendMode
from ethercat_debug_tool.services.manual_service import manual_index, manual_references, read_manual
from ethercat_debug_tool.web_bridge import WebBridgeServer

MANUALS = Path(__file__).resolve().parents[1] / "desktop/src-tauri/resources/manuals"


# Loading uses unchanged vendor bytes, whose revision matches the independently generated index.
@pytest.mark.parametrize("filename", list(manual_index()))
def test_original_bytes_match_versioned_index(filename):
    data = read_manual(filename, MANUALS)
    assert data == (MANUALS / filename).read_bytes()
    assert hashlib.sha256(data).hexdigest() == manual_index()[filename]["sha256"]


# Equal numeric addresses in different spaces must resolve to different register descriptions.
def test_revision_specific_spaces_and_expanded_channels():
    registry = ProfileRegistry()
    assert [ref["pdf_page"] for ref in manual_references(registry.find("LAN9252", "hbi_local", 0))] == [83, 83]
    assert [ref["pdf_page"] for ref in manual_references(registry.find("LAN9252", "esc_core", 0))] == [227, 227]
    assert manual_references(registry.find("E252", "esc_core", 0x0810)) == manual_references(registry.find("E252", "esc_core", 0x0800))
    assert manual_references(registry.find("ET1100", "esc_core", 0x0152))[0]["pdf_page"] == 44


# Language revisions have separate files and indices even when chapter pages coincide.
def test_chinese_and_english_have_independent_physical_pages():
    document_zh = manual_index()["microchip_lan9252_register_zh.pdf"]
    document_en = manual_index()["microchip_lan9252_register_en.pdf"]
    assert document_zh["version"] != document_en["version"]
    assert document_zh["page_count"] == 329 and document_en["page_count"] == 332
    assert document_zh["sha256"] != document_en["sha256"]
    assert document_zh["registers"] is not document_en["registers"]
    key = "esc_core|0x0130-0x0131"
    assert document_zh["registers"][key]["pdf_page"] == 240
    assert document_en["registers"][key]["pdf_page"] == 240


# Missing sources cannot acquire a fabricated page or a generic ET1100 hardware overview.
def test_unmapped_reference_remains_searchable():
    references = manual_references({"source_chip": "ET1100", "source": []})
    assert all(ref["pdf_page"] is None for ref in references)


# Reject both absolute paths and traversal rather than exposing a general file reader.
@pytest.mark.parametrize("filename", ["../secret.pdf", "C:/secret.pdf", "notes.pdf"])
def test_read_allowlist(filename):
    with pytest.raises(ValueError, match="未知"):
        read_manual(filename, MANUALS)


# Metadata navigation must not wait for the hardware command lock.
def test_register_detail_contains_local_navigation_metadata():
    runtime = BridgeRuntime(SimpleNamespace(event=lambda *args: None), BackendMode.DEMO)
    definition = runtime.profiles.find("E252", "esc_core", 0x0130)
    try:
        with runtime._command_lock:
            detail = runtime.dispatch("register_definition", {
                "position": 1, "profile": "E252", "definition_id": definition["definition_id"],
            })
        assert detail["manuals"][0]["pdf_page"] == 240
        assert detail["manuals"][0]["sha256"]
        assert "register_manual_open" not in runtime.registry.commands
    finally:
        runtime.shutdown()


# The binary browser route works without creating or dispatching an EtherCAT runtime.
def test_browser_pdf_route_is_binary_and_allowlisted():
    server = WebBridgeServer(("127.0.0.1", 0), SimpleNamespace())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/api/register-manual/"
    try:
        with urlopen(base + "beckhoff_esc_register_en.pdf") as response:
            assert response.headers["Content-Type"] == "application/pdf"
            assert response.read() == read_manual("beckhoff_esc_register_en.pdf", MANUALS)
        with pytest.raises(HTTPError) as error:
            urlopen(base + "../secret.pdf")
        assert error.value.code == 400
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
