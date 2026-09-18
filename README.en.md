# BenchCAT

[简体中文](README.md) | [English](README.en.md)

An EtherCAT slave debugging and diagnostics workbench for Windows. The desktop application uses **Tauri 2, Rust, React, TypeScript, Material UI, and Emotion**. Python owns the EtherCAT hardware core behind a persistent local JSON bridge; the WebView never accesses pySOEM directly.

This project uses [pySOEM](https://github.com/bnjmnp/pysoem) for EtherCAT master communication. Hardware communication on Windows depends on the official [Npcap](https://npcap.com/) driver; Npcap is not included in this repository or application.

> [!WARNING]
> Startup enumerates adapters and attempts connection and bus scanning. Discovery configures slaves to PRE-OP and maps PDOs to read fixed I/O widths; it does not enter OP or start cyclic communication. State transitions, register writes, and EEPROM operations can affect machinery or make a slave temporarily unavailable. Use an isolated, recoverable test setup.

## Why BenchCAT

BenchCAT brings bus discovery, state diagnostics, ESC register inspection, and EEPROM maintenance into one desktop workflow while isolating hardware requests in one communication Worker. CoE, PDO mapping, and online I/O code remains in the repository but those pages are hidden from the current public navigation.

| Concern | Implementation |
| --- | --- |
| Safe first contact | Startup scans and stops in PRE-OP; it does not enter OP or start cyclic communication |
| Responsive UI | The WebView never calls pySOEM; hardware work runs asynchronously in the Python bridge |
| Request consistency | One Worker serializes requests for one Master |
| Write control | Registers use two-stage plans and readback; EEPROM uses capacity, structure, semantic, and full-image verification |
| Traceability | UI progress, JSONL logs, and `AUDIT` write records retain diagnostic context |

## User guide

### Windows and Npcap requirements

Hardware communication uses the official Windows wheel `pysoem==1.1.13`. It requires:

- Windows 10/11 x64;
- Node.js 20 or newer, pnpm/Corepack, Rust MSVC, and WebView2 for source builds;
- Python 3.11 or newer;
- Npcap 1.88 or newer with **WinPcap API-compatible Mode** enabled;
- administrator/raw-packet access to the selected adapter;
- preferably, a dedicated EtherCAT adapter that carries no ordinary network traffic.

The application reports actionable errors when Npcap/wpcap is missing, permissions are insufficient, or an adapter cannot be opened.

### Install and run

Release builds use the Tauri 2 Windows bundle flow and produce only an NSIS (`.exe`) installer with a Simplified Chinese installer and uninstaller UI; MSI packages are no longer built or published. The installer includes a standalone Python bridge, the Python runtime, and `pysoem==1.1.13`, so target computers do not need a separate Python installation. Npcap is not bundled; hardware communication still requires a separate Npcap installation with WinPcap API-compatible Mode enabled. Run in PowerShell:

```powershell
git clone https://github.com/LINLin190/BenchCAT.git
Set-Location "BenchCAT"
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
.\start-desktop.ps1
```

You can also double-click `Start-BenchCAT.cmd`. The launcher prefers global pnpm, a locally cached Corepack version, or Corepack, and removes only project-owned stale Vite processes before startup. Vite uses port `1420`; an unrelated process holding it is reported and left untouched.

Browser-only layout preview:

```powershell
Set-Location desktop
pnpm install
pnpm dev
```

### Recommended workflow

The public workflow is `1. Automatic or manual scan -> 2. Select slave -> 3. Read state and AL -> 4. Register or EEPROM diagnostics`.

1. Startup attempts connection and scanning; use **Detect and scan** to run it again.
2. If automatic scanning finds no slave, select an adapter, click **Connect**, then **Scan**, and select the target in the slave tree. Discovery maps PDOs in PRE-OP and caches identity, PDI, and I/O widths.
3. Read actual state and AL status first. State buttons may request a target directly; the backend performs required intermediate transitions and stops cyclic communication before downgrading. Discovery maps PDOs once and caches fixed I/O widths.
4. In Registers, read before writing and confirm the slave, catalog, address, current value, and target value. Regenerate plans older than 60 seconds.
5. For EEPROM, stop cyclic communication and put the target in INIT. Back up a BIN first, then select XML/Device, inspect Smart View and capacity, and program or restore.

### Implemented functionality

- adapter detection and selection, manual connect/disconnect, scan, identities, AL status, direct state requests, reconfigure, and recovery;
- ESC register catalogs for ET1100, LAN9252, and LAN9253 with search, categories, bit fields, raw access, monitoring, change highlighting, and copy;
- two-stage register writes bound to slave identity, with semantic readback and `AUDIT` logging;
- ESI XML selection, drag and drop, five recent files, multiple Device entries, SII generation, Smart View, and capacity checks;
- complete EEPROM reads, BIN backups, changed-word writes, per-word readback, settling wait, full reread, byte/SHA-256/structure/identity-semantic validation, and BIN restore;
- exclusive three-frame ESC ECAT reset using `0x0040 <- 0x52/0x45/0x53`, bounded rediscovery polling, and separate rediscovery/reload results;
- persistent JSONL logs under `%LOCALAPPDATA%\BenchCAT\logs`; every write operation is recorded as `AUDIT`.

## AL status codes

Overview reads the ESC standard AL status register `0x0134` and shows the code, name, details, and troubleshooting action. Use **Settings -> AL status language** to switch between Chinese and English; the choice is persisted locally.

| Range/code | Meaning |
| --- | --- |
| `0x0000` | No error |
| `0x0001`-`0x0083`, `0x00F0` | Built-in common catalog covering firmware/SII, state transitions, mailbox, SyncManager, PDO, watchdog, synchronization, DC, power, temperature, and application-controller conditions |
| `0x8000`-`0xFFFF` | Vendor-specific; the UI does not guess its meaning. Consult the device manual, ESI, and vendor diagnostic objects |
| Other values | Unlisted, reserved, or newer extension candidates; reread `0x0134` and consult device documentation |

`0x0050` means **EEPROM no access**. This code alone does not prove PDI ownership or an EEPROM lock, and `0x0500 == 0` is not positive proof. Read `0x0500`, `0x0501`, and `0x0502` together and correlate ownership, Busy/error bits, firmware state, logs, and captures. `0x0051` is more consistent with an EEPROM read/write, acknowledgement, or verification failure. State-transition errors include the slave name, actual state, and AL code.

## EEPROM safety rules

EEPROM programming is allowed only with cyclic communication stopped and the target slave in INIT. Identity mismatches are warnings only and do not require an extra confirmation. The selected XML/Device fully defines the target image; XML text is never written directly, and old Serial Number, Station Alias, or private data is not silently merged.

Invalid XML, failed SII generation, unreadable or mismatched physical capacity, running cyclic communication, another EEPROM operation, or communication failure blocks the operation. During programming or restore, other hardware commands immediately return `EEPROM_BUSY`. Cancellation is shown neutrally as **Cancelled**. Verification details include the `first_difference` offset, and the complete backup path is shown after backup.

`image_success` is true only when complete readback is byte-for-byte identical to the target, both SHA-256 values match, SII structure is valid, and XML semantic validation passes. Reset rediscovery and reload failures are reported separately and do not alter completed image verification.

### ESI-to-SII conversion boundary

Supported: ConfigData/CRC-8, Identity, standard Mailbox, Strings, General, FMMU, SyncManager, RxPDO/TxPDO, DC OpMode, standard primitive CoE types, and BIT1-BIT8. Vendor-private Categories, a complete custom DataTypes dictionary, EoE/FoE-specific data, and arbitrary complete ESI Schema coverage are not claimed; omissions are reported rather than silently ignored. Smart View shows category, type, offset, length, and content preview.

## ESC profiles and identification

`chip_model` and `register_family` are stored separately. Profiles include E101, E252, E253, ET1100, LAN9252, LAN9253, and Generic ESC; domestic models are not displayed as original vendor chips. Identification first uses ESC type register `0x0000` (`0x11` for ET1100) and chip identification register `0x0E02` (LAN9252/LAN9253), then uses legacy identifiers and FMMU, SyncManager, and RAM traits only as a LAN9252 fallback. Vendor-specific registers, exact encodings, EEPROM timing, and reset compatibility for E101/E252/E253 remain unverified on physical hardware.

## Developer guide

### Architecture principles

- React pages handle presentation and interaction; Tauri Rust handles desktop lifecycle and bridging.
- The Python bridge is the only hardware entry point; the WebView never calls pySOEM directly.
- EtherCatWorker is the sole Backend owner and serializes hardware requests for one Master.
- EEPROM exclusivity, state checks, confirmations, and verification are enforced in the service/backend layers. A successful `recover()` is followed by actual-state and AL-status verification.

### Build the Windows application

Maintainers can validate the frontend and create the self-contained Python bridge separately from the `desktop` directory:

```powershell
Set-Location desktop
pnpm install
pnpm build
pnpm build:bridge
```

Run `pnpm tauri:build` only after the development application and frozen bridge have been verified. Tauri copies the complete `onedir` output under `desktop/src-tauri/resources/bridge` into the installed resource directory; the Release host does not invoke system Python or a build-machine source path.

Before distributing an application bundle, verify WebView2, the Python bridge, pySOEM, and Npcap deployment boundaries on Windows x64. Npcap is never bundled.

### Tests and build checks

Automated tests use Mock backends and versioned ESI/BIN fixtures. A local LYW ESI regression test is skipped when its optional external fixture is absent. They do not open a physical adapter or write real PDO outputs, EEPROM, or registers.

```powershell
python -m ruff check src tests
python -m pytest -q
Set-Location desktop
pnpm build
pnpm test
```

Current visual acceptance targets are `2560 x 1440` (default), `1920 x 1080`, and `1280 x 720` (minimum window size).

## Current limitations and physical verification

> [!CAUTION]
> Passing Mock tests does not establish physical EtherCAT hardware verification.

- One E252-EVB-SPI slave has verified PRE-OP mapping of 6 B input and 2 B output, short PDO cyclic communication, and several state-change rounds. Twenty rounds and multi-slave topologies still require isolated-device validation;
- the firmware/PDI paths behind INIT-to-PRE-OP `0x0050`/`0x0051` require device documentation or captures;
- vendor bit fields, private registers, and exact chip encodings for E101/E252/E253 require datasheets or hardware captures;
- vendor-private SII Categories and arbitrary complete ESI Schema conversion are outside the current support claim;
- CoE, PDO mapping, and online I/O pages are hidden in this release; the standard register catalog does not claim complete coverage of every vendor extension.

For first physical contact, enumerate adapters, connect and scan (PRE-OP/PDO mapping), read state/AL, read registers, and read and store an EEPROM BIN offline. Confirm that the backup parses and that the equipment is safe before validating writes on an isolated test slave.

## Safety notice

EtherCAT state, register, and EEPROM writes can affect machinery or make a slave temporarily unavailable. Verify the selected slave and address before each write, keep a known-good EEPROM backup, and ensure connected equipment is in a safe state.

## License

BenchCAT is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). It is **source-available software**, not open-source software as defined by the OSI. Personal, educational, research, and other noncommercial use is permitted; commercial products, paid services, commercial internal operations, and paid support require separate written permission. Distributions must retain the complete license, Required Notice, copyright notice, project URL, and a clear description of modifications. Third-party components remain under their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

[GitHub Issues](https://github.com/LINLin190/BenchCAT/issues) are welcome for bug reports, feature requests, and clearly labeled physical-hardware read-only validation results. Include reproduction steps, expected/actual behavior, the slave and ESC model, ESI file, environment, and verification method. Do not submit tests that automatically write real EEPROM, PDO outputs, or registers, and do not publish serial numbers, production configuration, or private ESI files.
