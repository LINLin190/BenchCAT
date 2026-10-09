from ethercat_debug_tool.al_status import _catalog, al_status_info


def test_shared_al_status_catalog_is_complete_and_actionable() -> None:
    assert len(_catalog()) == 61
    eeprom = al_status_info(0x0050)
    assert eeprom.known and eeprom.name == "EEPROM 无访问权"
    assert "0x0500" in eeprom.action and "0x0501" in eeprom.action and "0x0502" in eeprom.action


def test_al_status_fallback_distinguishes_vendor_specific_values() -> None:
    assert al_status_info(0x0003).name == "未知AL状态码"
    assert al_status_info(0x8001).name == "厂商自定义 AL 状态码"

