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

`register_manual_index.json` stores physical PDF pages separately for each bundled document and pins each file by SHA-256. Rebuild it from the project root with `python packaging/index-register-manuals.py` after replacing a manual. The Chinese index uses its own section/table bookmarks; English catalogue pages are used only for their matching document revisions. The ET1100 hardware link opens the register overview; individual register descriptions are in Section II.

BenchCAT displays original PDF bytes in an embedded PDF.js viewer. Page navigation uses the physical page sequence after the viewer initializes; printed page labels do not affect navigation. Register locations are keyed by document revision, address space and address range, with source-section references retained for expanded channels and RAM windows. Missing locations show the register name and address for text search. The table of contents starts closed on every manual visit and loads on demand. When opened, it preserves vendor bookmark hierarchy, expands to the selected register chapter and follows page or named destinations. Only expanded branches are rendered, independently of page, zoom and search-count updates. The ET1100 hardware manual provides an overview rather than individual register tables.

The viewer and its worker, CMaps, standard fonts, ICC profiles and WASM decoders are bundled locally for offline use. The PDF engine loads on the first manual click, renders pages on demand within bounded canvas memory and retains only the current parsed document between visits. Closing detaches page canvases and cancels rendering and search; reopening the same document reuses its parsed data. Switching manuals aborts obsolete loads and disposes the previous worker. Search counts and container resize updates are coalesced, and register acquisition updates do not rerender the viewer. Documents are checked against the index SHA-256 before loading. No PDF copies are generated, and manual loading does not use the EtherCAT command transport. PDF.js is distributed under Apache-2.0; its license is included in the frontend assets.

The catalog separates ECAT and PDI permissions, read acknowledgements, write-any-clear counters, and mutually exclusive PDI field tables. LAN9252 C's overlapping ASIC reserved range is marked as an editorial correction in the register notes. LAN9253 PHY management's unassigned bit 7 remains unspecified rather than receiving an invented meaning.
