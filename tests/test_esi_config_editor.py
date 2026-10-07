import hashlib

import pytest

from ethercat_debug_tool.esi.config_editor import EsiConfigSaveError, save_config_data
from ethercat_debug_tool.esi.parser import EsiParser


# Namespaces, comments, encoding, and other Devices must survive a targeted source edit.
@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])
def test_config_save_preserves_other_xml_bytes(tmp_path, encoding):
    xml = f'''<?xml version="1.0" encoding="{encoding}"?>
<EtherCATInfo xmlns="urn:esi"><Vendor><Id>2</Id></Vendor><Descriptions><Devices>
<!-- retain this comment -->
<Device><Type ProductCode="1" RevisionNo="1">First</Type><Eeprom><ByteSize>2048</ByteSize><ConfigData>050E</ConfigData></Eeprom></Device>
<Device><Type ProductCode="2" RevisionNo="1">Second</Type><Eeprom><ByteSize>2048</ByteSize><ConfigData>  <![CDATA[8000]]>  </ConfigData></Eeprom></Device>
</Devices></Descriptions></EtherCATInfo>'''
    source = tmp_path / "source.xml"
    raw = xml.encode(encoding)
    source.write_bytes(raw)
    document = EsiParser().parse(source)
    saved = save_config_data(document, 1, "89 0E 00")
    expected = xml.replace("<![CDATA[8000]]>", "<![CDATA[890E00]]>").encode(encoding)
    assert source.read_bytes() == expected
    assert saved.path == source
    assert saved.sha256 == hashlib.sha256(expected).hexdigest()
    assert saved.devices[0].config_data == bytes.fromhex("050E")
    assert saved.devices[1].config_data == bytes.fromhex("890E00")
    source.write_bytes(expected + "\n".encode(encoding))
    externally_changed = source.read_bytes()
    with pytest.raises(EsiConfigSaveError, match="其他操作修改"):
        save_config_data(saved, 1, "05")
    assert source.read_bytes() == externally_changed
