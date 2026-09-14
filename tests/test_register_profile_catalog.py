import threading
import time

import pytest

from ethercat_debug_tool.esc_profiles.profiles import ProfileRegistry
from ethercat_debug_tool.models import BackendMode


def test_each_profile_has_its_investigated_register_set_and_domestic_isomorphic() -> None:
    registry = ProfileRegistry()
    expected_counts = {"ET1100": 216, "LAN9252": 161, "LAN9253": 176}
    for chip, expected in expected_counts.items():
        assert len(registry.catalog(chip)) == expected

    for domestic, original in (("E101", "ET1100"), ("E252", "LAN9252"), ("E253", "LAN9253")):
        clone = registry.catalog(domestic)
        source = registry.catalog(original)
        assert len(clone) == len(source)
        assert [(item["address_space"], item["address_text"], item["name"]) for item in clone] == [
            (item["address_space"], item["address_text"], item["name"]) for item in source
        ]
        assert all(item["profile"] == domestic for item in clone)


def test_domestic_profiles_use_the_same_resource_limits_as_their_original_profiles() -> None:
    registry = ProfileRegistry()
    for domestic, original in (("E101", "ET1100"), ("E252", "LAN9252"), ("E253", "LAN9253")):
        assert registry.get(domestic).pram_start == registry.get(original).pram_start
        assert registry.get(domestic).pram_end == registry.get(original).pram_end
        assert registry.get(domestic).fixed_fmmu_count == registry.get(original).fixed_fmmu_count
        assert registry.get(domestic).fixed_sm_count == registry.get(original).fixed_sm_count


def test_same_address_has_profile_scoped_meaning() -> None:
    registry = ProfileRegistry()
    et1100 = registry.find("ET1100", "esc_core", 0x0E00)
    lan9252 = registry.find("LAN9252", "esc_core", 0x0E00)
    lan9253 = registry.find("LAN9253", "esc_core", 0x0E00)
    assert et1100 and lan9252 and lan9253
    assert et1100["name"] == "Power-on values ET1100"
    assert lan9252["name"] == lan9253["name"] == "Product Id Register"
    assert et1100["width"] == 2 and lan9252["width"] == lan9253["width"] == 8
    assert len({et1100["definition_id"], lan9252["definition_id"], lan9253["definition_id"]}) == 3


@pytest.mark.parametrize("profile,width", [("ET1100", 16), ("E101", 16), ("LAN9252", 64), ("E252", 64), ("LAN9253", 64), ("E253", 64)])
def test_hardware_fields_cover_each_bit_once(profile, width):
    definition = ProfileRegistry().find(profile, "esc_core", 0x0E00)
    covered = set()
    for field in definition["bit_fields"]:
        bits = set(range(field["shift"], field["shift"] + field["bits"]))
        assert not covered.intersection(bits)
        covered.update(bits)
    assert covered == set(range(width))
    assert definition["direct_read_allowed"] and not definition["direct_write_allowed"]
    assert all(field["ecat_access"] == "RO" for field in definition["fields"])


def test_local_lan925x_registers_are_documented_but_not_master_accessible() -> None:
    registry = ProfileRegistry()
    local = next(item for item in registry.catalog("LAN9252") if item["address_space"] == "lan925x_system_csr")
    assert local["master_access_allowed"] is False
    assert local["direct_read_allowed"] is False
    assert local["direct_write_allowed"] is False


def test_generic_catalog_keeps_the_common_master_accessible_registers_visible() -> None:
    catalog = ProfileRegistry().catalog("Generic ESC")
    assert len(catalog) > 0
    assert all(item["address_space"] == "esc_core" for item in catalog)
    assert any(item["address"] == 0x0120 for item in catalog)


def test_bridge_can_use_a_manually_selected_register_profile() -> None:
    from ethercat_debug_tool.bridge import BridgeRuntime

    class Writer:
        def event(self, *_args: object) -> None:
            pass

    runtime = BridgeRuntime(Writer(), BackendMode.DEMO)
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        catalog = runtime.dispatch("register_catalog", {"position": 1, "profile": "LAN9252"})
        product_id = next(item for item in catalog if item["address_space"] == "esc_core" and item["address"] == 0x0E00)
        assert len(catalog) == 161
        assert product_id["name"] == "Product Id Register"
        assert "fields" not in product_id
        detail = runtime.dispatch(
            "register_definition",
            {"position": 1, "profile": "LAN9252", "definition_id": product_id["definition_id"]},
        )
        assert detail["fields"]
    finally:
        runtime.shutdown()


def test_lan_catalogs_do_not_wait_for_hardware_command_lock() -> None:
    from ethercat_debug_tool.bridge import BridgeRuntime

    class Writer:
        def event(self, *_args: object) -> None:
            pass

    runtime = BridgeRuntime(Writer(), BackendMode.DEMO)
    lock_acquired = threading.Event()
    release = threading.Event()

    def hold_hardware_command_lock() -> None:
        with runtime._command_lock:
            lock_acquired.set()
            release.wait(1)

    holder = threading.Thread(target=hold_hardware_command_lock)
    holder.start()
    try:
        assert lock_acquired.wait(0.5)
        started = time.perf_counter()
        lan9252 = runtime.dispatch("register_catalog", {"position": 1, "profile": "LAN9252"})
        lan9253 = runtime.dispatch("register_catalog", {"position": 1, "profile": "LAN9253"})
        assert time.perf_counter() - started < 0.5
        assert len(lan9252) == 161
        assert len(lan9253) == 176
    finally:
        release.set()
        holder.join(timeout=1)
        runtime.shutdown()


def test_known_local_register_write_is_rejected_before_backend_access() -> None:
    from ethercat_debug_tool.bridge import BridgeRuntime

    class Writer:
        def event(self, *_args: object) -> None:
            pass

    runtime = BridgeRuntime(Writer(), BackendMode.DEMO)
    try:
        runtime.dispatch("auto_scan", {"preferred_adapter": "demo0"})
        definition = next(
            item
            for item in ProfileRegistry().catalog("E252")
            if item["address_space"] == "lan925x_system_csr"
        )
        with pytest.raises(PermissionError, match="local to the PDI/HBI/PHY"):
            runtime.dispatch(
                "register_prepare_write",
                {
                    "position": 2,
                    "address": definition["address"],
                    "data": "00 00 00 00",
                    "semantics": "RW",
                    "known_register": True,
                    "definition_id": definition["definition_id"],
                },
            )
    finally:
        runtime.shutdown()
