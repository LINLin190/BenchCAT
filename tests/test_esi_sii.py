import copy
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from ethercat_debug_tool.esi.parser import EsiParser
from ethercat_debug_tool.sii.generator import SiiGenerator
from ethercat_debug_tool.sii.parser import SiiParser, SiiValidationError


def test_sample_esi_device_and_pdo_fields(sample_esi) -> None:
    device = sample_esi.devices[0]
    assert device.name == "ET1100_402"
    assert device.product_code == 0x26483052
    assert device.byte_size == 2048
    assert device.rx_pdos[0].entries[0].bit_length == 16
    assert any(entry.index == 0x1018 and entry.subindex == 1 for entry in device.objects)


def test_one_xml_can_expose_multiple_devices(workspace: Path, tmp_path: Path) -> None:
    root = ET.parse(workspace / "ESI示例" / "SlaveCTT_900e80.xml").getroot()
    devices = next(node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "Devices")
    clone = copy.deepcopy(next(iter(devices)))
    devices.append(clone)
    path = tmp_path / "multi-device.xml"
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    assert len(EsiParser().parse(path).devices) == 2


def test_parse_supplied_binary_vector(workspace: Path) -> None:
    raw = (workspace / "ESI示例" / "Box 1 (ET1100_402).bin").read_bytes()
    image = SiiParser().parse(raw)
    assert image.capacity == 2048
    assert image.vendor_id == 9
    assert image.product_code == 0x26483052
    assert image.end_offset % 2 == 0
    assert {category.kind for category in image.categories} >= {0x0A, 0x1E, 0x28, 0x29, 0x32, 0x33, 0x3C}


def test_generate_complete_image_and_semantic_roundtrip(sample_esi) -> None:
    device = sample_esi.devices[0]
    report = SiiGenerator().generate(device)
    image = SiiParser().parse(report.image)
    assert len(report.image) == device.byte_size
    assert (image.vendor_id, image.product_code, image.revision) == (
        device.vendor_id,
        device.product_code,
        device.revision,
    )
    assert report.image[image.end_offset : image.end_offset + 2] == b"\xff\xff"
    general = next(category for category in image.categories if category.kind == 0x001E)
    assert general.payload[16] == 0x11
    assert "vendor-specific categories" not in report.omitted


def test_mailbox_fixed_area_follows_standard_layout(sample_esi) -> None:
    import struct

    device = sample_esi.devices[0]
    image = SiiGenerator().generate(device).image
    # Standard mailbox: MBoxOut 0x1000/128 at 0x30, MBoxIn 0x1100/128 at 0x34.
    assert image[0x30:0x32] == (0x1000).to_bytes(2, "little")
    assert image[0x32:0x34] == (128).to_bytes(2, "little")
    assert image[0x34:0x36] == (0x1100).to_bytes(2, "little")
    assert image[0x36:0x38] == (128).to_bytes(2, "little")
    # Bootstrap mailbox comes from the ESI BootStrap hex at 0x28.
    assert image[0x28:0x30] == bytes.fromhex("0010800080108000")
    # CoE-only mailbox; the reserved words stay zero even with a bootstrap mailbox.
    assert image[0x38:0x3A] == (0x0004).to_bytes(2, "little")
    assert image[0x3A:0x3C] == b"\x00\x00"
    # Reserved fixed area is zero-filled like SSC-generated images; the
    # EEPROM size word sits at 0x7C.
    assert image[0x20:0x28] == b"\x00" * 8
    assert image[0x3C:0x7C] == b"\x00" * (0x7C - 0x3C)
    assert image[0x7C:0x80] == struct.pack("<HH", 2048 // 128 - 1, 1)


def test_sync_manager_category_uses_standard_type_codes(sample_esi) -> None:
    import struct

    report = SiiGenerator().generate(sample_esi.devices[0])
    image = SiiParser().parse(report.image)
    sm = next(category for category in image.categories if category.kind == 0x0029)
    types = [struct.unpack_from("<HHBBBB", sm.payload, offset)[5] for offset in range(0, len(sm.payload), 8)]
    assert types == [1, 2, 3, 4]


# Read the byte-sized DC/name fields independently of the generator's packing format.
def test_pdo_header_uses_separate_dc_and_name_bytes(sample_esi) -> None:
    import struct
    from dataclasses import replace

    from ethercat_debug_tool.esi.parser import EsiEntry, EsiPdo

    device = replace(
        sample_esi.devices[0],
        byte_size=2048,
        tx_pdos=(
            EsiPdo(
                0x1A00, "DI TxPDO-Map", 3,
                (EsiEntry(0x6041, 0, 16, "Status", "UINT", 0x0010),), 0x0011, 2,
            ),
        ),
        rx_pdos=(),
        dc_modes=(),
    )
    report = SiiGenerator().generate(device)
    image = SiiParser().parse(report.image)
    category = next(category for category in image.categories if category.kind == 0x0032)
    assert category.payload[:5] == bytes.fromhex("001A010302")
    assert image.strings[category.payload[5] - 1] == "DI TxPDO-Map"
    assert category.payload[6:8] == b"\x11\x00"
    entry_index, subindex, _, _, bit_length, entry_flags = struct.unpack_from("<HBBBBH", category.payload, 8)
    assert (entry_index, subindex, bit_length, entry_flags) == (0x6041, 0, 16, 0x0010)


# Nonzero timing and signed values expose field overlap hidden by zero-only images.
def test_dc_entry_layout_matches_etg2010() -> None:
    import struct

    from ethercat_debug_tool.esi.parser import EsiDcMode

    class Strings:
        @staticmethod
        def index(value):
            return 1 if value else 0

    mode = EsiDcMode("DC", "DC-Synchron", 0x0700, 1_000_000, 500, 2_000_000, -250, 1, 2)
    payload = SiiGenerator._dc(mode, Strings())
    assert len(payload) == 24
    assert struct.unpack_from("<I", payload, 0)[0] == 1_000_000
    assert struct.unpack_from("<i", payload, 4)[0] == 500
    assert struct.unpack_from("<i", payload, 8)[0] == -250
    assert struct.unpack_from("<h", payload, 12)[0] == 2
    assert payload[14:16] == b"\x00\x07"
    assert payload[16:18] == b"\x00\x00"
    assert payload[18:] == b"\x01\x00\x00\x00\x00\x00"
    mode = EsiDcMode("DC", "", 0x0300, 0, 0, 0, 0, -2, 1)
    payload = SiiGenerator._dc(mode, Strings())
    assert payload[12:14] == b"\x00\x00"
    assert struct.unpack_from("<h", payload, 16)[0] == -2


def test_corrupt_header_and_missing_end_marker_are_rejected(workspace: Path) -> None:
    raw = bytearray((workspace / "ESI示例" / "Box 1 (ET1100_402).bin").read_bytes())
    raw[0] ^= 1
    with pytest.raises(SiiValidationError, match="CRC"):
        SiiParser().parse(raw)
    raw = bytearray((workspace / "ESI示例" / "Box 1 (ET1100_402).bin").read_bytes())
    raw[0x1A4:] = b"\x00" * (len(raw) - 0x1A4)
    with pytest.raises(SiiValidationError, match="end marker"):
        SiiParser().parse(raw)


def test_large_lyw_esi_generates_capacity_safe_sii(workspace: Path) -> None:
    import struct

    path = workspace / "LYW_CanMotor_SIP-V2.2" / "XHD_CAN_Motor_18x8.xml"
    if not path.exists():
        pytest.skip("optional local LYW ESI fixture is not available")
    document = EsiParser().parse(path)
    device = document.devices[0]

    report = SiiGenerator().generate(device)
    image = SiiParser().parse(report.image)
    raw = report.image

    assert len(report.image) == 2048
    assert (image.vendor_id, image.product_code, image.revision) == (0x153, 1, 1)
    # Standard mailbox: MBoxOut 0x1000/128, MBoxIn 0x1080/128, CoE protocol.
    assert raw[0x30:0x32] == (0x1000).to_bytes(2, "little")
    assert raw[0x32:0x34] == (128).to_bytes(2, "little")
    assert raw[0x34:0x36] == (0x1080).to_bytes(2, "little")
    assert raw[0x36:0x38] == (128).to_bytes(2, "little")
    assert raw[0x38:0x3A] == (0x0004).to_bytes(2, "little")
    assert raw[0x3A:0x3C] == b"\x00\x00"
    # No BootStrap in the LYW ESI: the bootstrap mailbox area stays zero.
    assert raw[0x28:0x30] == b"\x00" * 8
    # Sync Manager category keeps the standard type codes.
    sm = next(category for category in image.categories if category.kind == 0x0029)
    types = [struct.unpack_from("<HHBBBB", sm.payload, offset)[5] for offset in range(0, len(sm.payload), 8)]
    assert types == [1, 2, 3, 4]
    # DC category: both modes with ETG.2010 layout and factors.
    dc = next(category for category in image.categories if category.kind == 0x003C)
    first = struct.unpack_from("<IiihHhBB4x", dc.payload, 0)
    second = struct.unpack_from("<IiihHhBB4x", dc.payload, 24)
    assert first[4] == 0x0000 and first[5] == 1 and first[3] == 0
    assert second[4] == 0x0300 and second[5] == 1 and second[3] == 0
    # 367 unique PDO entry names cannot fit the 255-entry SII string table,
    # and even the nameless PDO encoding exceeds 2048 bytes: PDO categories
    # are omitted and the report states the measured reason.
    assert not ({0x0032, 0x0033} & {category.kind for category in image.categories})
    assert any("PDO categories omitted" in item for item in report.omitted)
    assert any("2048" in item for item in report.omitted)


# String-table limits must remove whole PDO categories rather than their entry names.
def test_complete_pdo_categories_dropped_when_strings_exceed_limit(sample_esi) -> None:
    from dataclasses import replace

    from ethercat_debug_tool.esi.parser import EsiEntry, EsiPdo

    pdos = tuple(
        EsiPdo(
            0x1A00 + index,
            f"Big TxPDO {index}",
            3,
            tuple(
                EsiEntry(0x6000, slot + 1, 8, f"UNIQUE_ENTRY_{index}_{slot:03d}", "USINT", 0)
                for slot in range(100)
            ),
            0x0001,
        )
        for index in range(3)
    )
    device = replace(
        sample_esi.devices[0],
        byte_size=8192,
        tx_pdos=pdos,
        rx_pdos=(),
        dc_modes=(),
    )
    report = SiiGenerator().generate(device)
    image = SiiParser().parse(report.image)
    assert not ({0x32, 0x33} & {category.kind for category in image.categories})
    assert not any(name.startswith("UNIQUE_ENTRY") for name in image.strings)
    assert len(report.image) == 8192
    assert any("PDO categories omitted" in item for item in report.omitted)
    assert "PDO" not in report.supported


# The Th reference retains byte 0x0B and its known CRC; FMMU padding is also observable.
def test_extended_config_and_fmmu_match_twincat_bytes(sample_esi) -> None:
    from dataclasses import replace

    device = replace(sample_esi.devices[0], config_data=bytes.fromhex("890E80CC88130000000000800000"))
    report = SiiGenerator().generate(device)
    assert report.image[:16] == bytes.fromhex("890E80CC881300000000008000008A00")
    image = SiiParser().parse(report.image)
    assert next(c.payload for c in image.categories if c.kind == 0x28) == bytes.fromhex("010203FF")
    assert image.strings[0] == device.type_name
    if device.sync_units:
        assert next(c.payload for c in image.categories if c.kind == 0x2B) == bytes.fromhex("F0FF")
    else:
        assert 0x2B not in {c.kind for c in image.categories}
    assert report.image[image.end_offset:] == b"\xff" * (2048 - image.end_offset)


# Use self-contained XML inputs to exercise the native TwinCAT field mappings.
def _conversion_xml(tmp_path: Path, *, eeprom: str = "", body: str = "", attributes: str = ""):
    path = tmp_path / "conversion.xml"
    path.write_text(
        '<EtherCATInfo><Vendor><Id>9</Id></Vendor><Descriptions><Groups>'
        '<Group><Type>First</Type><Name>First group</Name></Group>'
        '<Group><Type>Second</Type><Name>Second group</Name></Group>'
        '</Groups><Devices><Device Physics="YY">'
        f'<Type ProductCode="1" RevisionNo="2" {attributes}>Part</Type>'
        '<Name>Device</Name><GroupType>Unknown</GroupType>'
        '<Eeprom><ByteSize>2048</ByteSize><ConfigData>8000</ConfigData>'
        f'{eeprom}</Eeprom>{body}</Device></Devices></Descriptions></EtherCATInfo>',
        encoding="utf-8",
    )
    return EsiParser().parse(path).devices[0]


# Resolve exact group references first, then fall back to the first declared group.
def test_twincat_group_fallback_with_multiple_groups(tmp_path: Path) -> None:
    device = _conversion_xml(tmp_path)
    image = SiiParser().parse(SiiGenerator().generate(device).image)
    general = next(c.payload for c in image.categories if c.kind == 0x1E)
    assert image.strings[general[0] - 1] == "First"
    assert image.strings[general[14] - 1] == "First group"
    path = tmp_path / "conversion.xml"
    path.write_text(path.read_text(encoding="utf-8").replace("Unknown", "Second"), encoding="utf-8")
    assert EsiParser().parse(path).devices[0].group_name == "Second group"


# Explicit mailbox bytes override SM values; incomplete SM pairs remain zero.
@pytest.mark.parametrize("mailbox,expected", [
    ("<Mailbox>0020800040208000</Mailbox>", bytes.fromhex("0020800040208000")),
    ("<Mailbox>00</Mailbox>", bytes(8)),
    ("<Mailbox/>", bytes(8)),
    ("", bytes.fromhex("0010800080118000")),
])
def test_twincat_explicit_eeprom_mailbox(tmp_path: Path, mailbox: str, expected: bytes) -> None:
    device = _conversion_xml(tmp_path, eeprom=mailbox, body=(
        '<Sm StartAddress="#x1000" DefaultSize="128" ControlByte="38">MBoxOut</Sm>'
        '<Sm StartAddress="#x1180" DefaultSize="128" ControlByte="34">MBoxIn</Sm>'
    ))
    assert SiiGenerator().generate(device).image[0x30:0x38] == expected


# TwinCAT accepts only complete bootstrap data and ordered mailbox SM pairs.
def test_twincat_incomplete_mailbox_and_bootstrap_stay_zero(tmp_path: Path) -> None:
    device = _conversion_xml(tmp_path, eeprom="<BootStrap>00108000</BootStrap>", body=(
        '<Sm StartAddress="#x1180" DefaultSize="128" ControlByte="34">MBoxIn</Sm>'
        '<Sm StartAddress="#x1000" DefaultSize="128" ControlByte="38">MBoxOut</Sm>'
    ))
    assert SiiGenerator().generate(device).image[0x28:0x38] == bytes(16)


# Category values use word addressing, a string terminator, and XML ordering.
def test_twincat_explicit_category_data_types_and_order(tmp_path: Path) -> None:
    device = _conversion_xml(tmp_path, eeprom=(
        '<Category><CatNo>32768</CatNo><Data>ABCD1234</Data></Category>'
        '<Category><CatNo>32769</CatNo><DataString> AB </DataString></Category>'
        '<Category><CatNo>32770</CatNo><DataUINT>4660</DataUINT></Category>'
        '<Category><CatNo>32771</CatNo><DataUDINT>305419896</DataUDINT></Category>'
        '<Category><CatNo>32768</CatNo><Data>AB</Data></Category>'
    ))
    report = SiiGenerator().generate(device)
    image = SiiParser().parse(report.image)
    assert [(c.kind, c.payload) for c in image.categories[:5]] == [
        (0x8000, bytes.fromhex("ABCD1234")),
        (0x8001, b" AB \x00\xff"),
        (0x8002, bytes.fromhex("3412")),
        (0x8003, bytes.fromhex("78563412")),
        (0x8000, b""),
    ]
    assert image.categories[5].kind == 0x0A
    assert "explicit EEPROM categories" in report.supported


# Signed current and identification survive independently of mailbox configuration.
def test_twincat_general_info_and_type_flags_without_mailbox(tmp_path: Path) -> None:
    device = _conversion_xml(tmp_path, attributes='TcCfgModeSafeOp="true" UseLrdLwr="1"', body=(
        '<Info><Electrical><EBusCurrent>-125</EBusCurrent></Electrical>'
        '<IdentificationAdo>#x1234</IdentificationAdo></Info>'
    ))
    image = SiiParser().parse(SiiGenerator().generate(device).image)
    general = next(c.payload for c in image.categories if c.kind == 0x1E)
    assert general[11] == 0x13
    assert general[12:14] == bytes.fromhex("83FF")
    assert general[18:20] == bytes.fromhex("3412")
    path = tmp_path / "conversion.xml"
    path.write_text(path.read_text(encoding="utf-8").replace("#x1234", "#x0134"), encoding="utf-8")
    image = SiiParser().parse(SiiGenerator().generate(EsiParser().parse(path).devices[0]).image)
    general = next(c.payload for c in image.categories if c.kind == 0x1E)
    assert general[11] == 0x0B
    assert general[18:20] == bytes(2)


# SoE defaults to one channel and contributes its protocol bit to the fixed area.
@pytest.mark.parametrize("soe,channels,protocol", [("", 1, 0x3F), ('ChannelCount="3"', 3, 0x3F), ('ChannelCount="0"', 0, 0x2F)])
def test_mailbox_protocols_and_soe_channel_count(tmp_path: Path, soe: str, channels: int, protocol: int) -> None:
    device = _conversion_xml(tmp_path, body=(
        f'<Mailbox DataLinkLayer="true"><AoE AdsRouter="true"/><EoE/><CoE/><FoE/><SoE {soe}/><VoE/></Mailbox>'
    ))
    report = SiiGenerator().generate(device)
    image = SiiParser().parse(report.image)
    general = next(c.payload for c in image.categories if c.kind == 0x1E)
    assert int.from_bytes(report.image[0x38:0x3A], "little") == protocol
    assert general[5:9] == bytes([1, 1, 1, channels])
    assert general[11] == 4


# An empty AoE declaration does not select TwinCAT's AdsRouter device class.
def test_aoe_without_ads_router_does_not_set_protocol(tmp_path: Path) -> None:
    device = _conversion_xml(tmp_path, body='<Mailbox><AoE/></Mailbox>')
    assert SiiGenerator().generate(device).image[0x38:0x3A] == bytes(2)


# Different port layouts must not all inherit the two-MII-port compatibility value.
@pytest.mark.parametrize("physics,compatibility,ports", [
    ("", 0, 0), ("Y", 6, 1), ("YY", 1, 0x11), ("YYY", 4, 0x111),
    ("YKY", 2, 0x131), ("YB", 13, 0x21), ("BB", 20, 0x22),
    ("H", 0, 4), ("yb", 13, 0x21), ("YYYYY", 0, 0),
])
def test_twincat_general_physical_type(tmp_path: Path, physics: str, compatibility: int, ports: int) -> None:
    from dataclasses import replace

    device = replace(_conversion_xml(tmp_path), physics=physics)
    image = SiiParser().parse(SiiGenerator().generate(device).image)
    general = next(c.payload for c in image.categories if c.kind == 0x1E)
    assert general[4] == compatibility
    assert int.from_bytes(general[16:18], "little") == ports


# Removing an oversized trailing category must preserve preceding category bytes.
def test_explicit_categories_are_clipped_whole_with_fixed_capacity(tmp_path: Path) -> None:
    from dataclasses import replace

    device = _conversion_xml(tmp_path, eeprom=(
        '<Category><CatNo>32768</CatNo><Data>12345678</Data></Category>'
        f'<Category><CatNo>32769</CatNo><Data>{"AB" * 2048}</Data></Category>'
    ))
    report = SiiGenerator().generate(replace(device, byte_size=256))
    image = SiiParser().parse(report.image)
    assert len(report.image) == 256
    assert image.categories[0].kind == 0x8000
    assert image.categories[0].payload == bytes.fromhex("12345678")
    assert 0x8001 not in {c.kind for c in image.categories}
    assert {0x0A, 0x1E} <= {c.kind for c in image.categories}
