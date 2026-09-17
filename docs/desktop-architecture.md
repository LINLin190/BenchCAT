# Desktop architecture

BenchCAT uses Tauri 2, React, TypeScript, Material UI, and Emotion for its only desktop interface. The Python package is a headless EtherCAT hardware core.

## Runtime

```text
React + MUI + Emotion
        │ typed commands/events
        ▼
Tauri 2 host (Rust)
        │ framed JSON over a per-process Windows Named Pipe
        ▼
Python bridge process
  Debug: source Python / Release: bundled PyInstaller onedir
        │ exclusive requests/events
        ▼
EtherCatWorker → services → Real/Mock backend → pySOEM
```

- The webview never imports or calls pySOEM.
- Release builds resolve the frozen bridge from Tauri's resource directory. They never depend on a target computer's `PATH`, Python installation, or the build machine's source tree.
- The Rust host owns one replaceable Python hardware-process generation. A hard command deadline terminates that generation before a clean, disconnected replacement is admitted.
- On Windows the Python process belongs to a kill-on-close Job Object, so a host crash cannot leave an orphaned Master owner.
- stdout and stderr are diagnostic logs only and cannot corrupt IPC framing.
- The Worker remains the sole owner of the EtherCAT Master and serializes all requests.
- The Python hardware core owns one authoritative Master state machine with validated transitions and phase invariants. Worker events retain the session that produced them, and stale events are rejected before they can change Master state.
- Binary data crosses the IPC boundary as uppercase hexadecimal strings.
- Real is the default mode. Demo can only be enabled in Settings and is visibly marked.

## Interface structure

The shell has a compact labeled navigation rail, a contextual slave panel, and one content canvas. The currently visible workspaces are:

1. Overview
2. Registers
3. EEPROM
4. Settings

CoE objects, PDO mapping, and Online I/O remain implemented but are temporarily hidden while the three primary workspaces are refined. Startup enumerates adapters and performs automatic connection/scanning when possible. Discovery configures slaves to PRE-OP, performs one PDO mapping to obtain authoritative I/O widths, and caches fixed identity/PDI data; it does not enter OP or start cyclic communication. State controls accept a target directly, use necessary intermediate transitions, and stop cyclic communication before an OP downgrade.

At 2560×1440 the content is capped at 1840 px. At 1920×1080 it is fluid. The compatibility floor is 1280×720.

## Verification gates

1. TypeScript type-check and Vite production build.
2. Python Ruff and MockBackend tests.
3. Rust `cargo check` and Tauri build.
4. Visual checks at 1920×1080 and 2560×1440.
5. Real-hardware verification before a production release.
## Bridge protocol v3

The Tauri host owns a per-process Windows Named Pipe and supervises the isolated Python
command engine. IPC is length-framed JSON (`u32le + payload`); stdout and stderr are log-only.
`src/ethercat_debug_tool/protocol/commands.json` is the shared command contract. Commands are admitted into bounded
control, metadata, and hardware lanes. Only the sole `EtherCatWorker` owns the backend/Master.

React calls are wrapped by the central Operation Store. Operations carry a page generation, host
generation, and EtherCAT session epoch and always converge to `completed`, `failed`, `cancelled`, or
`unknown`. Navigation advances the page generation before mounting the target page, so its initial
requests are not cancelled as stale. A response that introduces a new host/session clock remains valid
as the source operation while older concurrent operations are invalidated. Every successful or failed Python response contains `result`, `session_id`, and one complete
Master snapshot captured atomically. Tauri validates the envelope and injects `host_generation` into
responses and events. React accepts snapshots monotonically by `(host_generation, session_id, revision)`;
heartbeat remains telemetry-only.
Transport loss makes an in-flight write `unknown`, never retried; reads become `failed`.
The Python heartbeat is telemetry, not proof that the Master-owning Worker is healthy. Native
pySOEM calls may either hold the GIL (suppressing heartbeat) or release it (heartbeat remains green
while the Worker is stuck). The out-of-process Tauri deadline is authoritative: expiry closes the
generation, kills its Job/Python process, waits for Master ownership to be reclaimed, invalidates
late results, and creates a new disconnected generation. Mutating operations are never retried and
remain `unknown` until the user reconnects and reads the device back.
