# Offline register manuals

These vendor documents are bundled with BenchCAT for local reference. Their original copyright notices remain in the PDFs. Filenames identify the document language; BenchCAT has not translated the English documents.

| Local file | Vendor document | Original download |
| --- | --- | --- |
| microchip_lan9252_register_zh.pdf | LAN9252, DS00001909A_CN, Chinese | https://ww1.microchip.com/downloads/cn/DeviceDoc/00001909a_cn.pdf |
| microchip_lan9252_register_en.pdf | LAN9252, DS00001909C, English | https://ww1.microchip.com/downloads/aemDocuments/documents/UNG/ProductDocuments/DataSheets/LAN9252-Data-Sheet-DS00001909.pdf |
| microchip_lan9253_register_en.pdf | LAN9253, DS00003421B, English | https://ww1.microchip.com/downloads/aemDocuments/documents/UNG/ProductDocuments/DataSheets/LAN9253-Data-Sheet-DS00003421.pdf |
| beckhoff_esc_register_en.pdf | EtherCAT ESC register description, Section II, version 3.3, English | https://download.beckhoff.com/download/document/io/ethercat-development-products/ethercat_esc_datasheet_sec2_registers_v3.3.pdf |
| beckhoff_et1100_datasheet_en.pdf | ET1100 hardware description, Section III, version 2.1, English | https://download.beckhoff.com/download/document/io/ethercat-development-products/ethercat_et1100_datasheet_v2i1.pdf |

Downloaded on 2026-10-05. The LAN9252 Chinese manual is an earlier revision than the English C revision used by the register catalog; both are available in the register inspector. Catalog provenance remains in `esc_register_database.json`.

The catalog separates ECAT and PDI permissions, read acknowledgements, write-any-clear counters, and mutually exclusive PDI field tables. LAN9252 C's overlapping ASIC reserved range is marked as an editorial correction in the register notes. LAN9253 PHY management's unassigned bit 7 remains unspecified rather than receiving an invented meaning.
