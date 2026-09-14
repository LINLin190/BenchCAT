import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AdapterInfo, AutoScanResult, BridgeEvent, BridgeExitInfo, EsiDevice, Mode, RegisterDefinition, SlaveInfo, WorkbenchStatus } from "./types";
import { normalizeBridgeFailure, operationStore } from "./operationStore";
import { acceptsSessionEvent, acceptsSnapshot } from "./snapshotClock";

const isTauri = "__TAURI_INTERNALS__" in window;
type Handler = (event: BridgeEvent) => void;
type SnapshotHandler = (snapshot: WorkbenchStatus) => void;
interface BridgeEnvelope<T> {
  result: T;
  host_generation: number;
  session_id: number;
  snapshot: WorkbenchStatus;
}

const snapshotHandlers = new Set<SnapshotHandler>();
let latestSnapshot: WorkbenchStatus | undefined;

function publishSnapshot(snapshot: WorkbenchStatus | undefined, sourceOperationId?: string) {
  if (!snapshot) return;
  if (!acceptsSnapshot(latestSnapshot, snapshot)) return;
  latestSnapshot = snapshot;
  operationStore.setSnapshotClock(snapshot.host_generation, snapshot.session_id, sourceOperationId);
  snapshotHandlers.forEach((handler) => handler(snapshot));
}

function publishHostFault(message: string, hostGeneration?: number) {
  const previous = latestSnapshot;
  publishSnapshot({
    host_generation: hostGeneration ?? previous?.host_generation ?? 0,
    mode: previous?.mode ?? "real",
    phase: "faulted",
    adapter: null,
    connected: false,
    cycle_running: false,
    slaves: [],
    session_id: previous?.session_id ?? 0,
    revision: previous?.revision ?? 0,
    last_error: message,
    worker_healthy: false,
    worker_state: "exited",
    queue_depth: 0,
  });
}

export function subscribeBusSnapshot(handler: SnapshotHandler): () => void {
  snapshotHandlers.add(handler);
  return () => snapshotHandlers.delete(handler);
}

const demoSlaves: SlaveInfo[] = [
  {
    position: 1,
    name: "EL1809 Digital Input",
    identity: { vendor_id: 2, product_code: 0x07113052, revision: 0x00120000, serial_number: 0 },
    state: 2,
    al_status: 0,
    input_size: 2,
    output_size: 0,
    configured_address: 1001,
    chip_model: "ET1100",
    esc_hardware: "4C 24",
    register_family: "ET1100",
    pdi_type: 0x04,
  },
  {
    position: 2,
    name: "EL2008 Digital Output",
    identity: { vendor_id: 2, product_code: 0x07d83052, revision: 0x00110000, serial_number: 0 },
    state: 2,
    al_status: 0,
    input_size: 0,
    output_size: 1,
    configured_address: 1002,
    chip_model: "ET1200",
    register_family: "ET1100",
    pdi_type: 0x04,
  },
  {
    position: 3,
    name: "Servo Drive",
    identity: { vendor_id: 0x11111111, product_code: 0x00006010, revision: 0x00010000, serial_number: 42 },
    state: 2,
    al_status: 0,
    input_size: 16,
    output_size: 16,
    configured_address: 1003,
    chip_model: "LAN9252",
    esc_hardware: "01 00 52 92 26 00 00 00",
    register_family: "LAN9252",
    pdi_type: 0x80,
  },
];

const previewRegisterDefinitions: RegisterDefinition[] = [
  {
    definition_id: "preview-esc-type", profile: "ET1100", source_chip: "ET1100",
    address: 0x0000, address_text: "0x0000", address_space: "esc_core", address_space_label: "ESC Core",
    size: 1, width: 1, name: "Type", group: "标识", access: "RO", master_access: "RO",
    master_access_allowed: true, direct_read_allowed: true, direct_write_allowed: false,
    description: "ESC 类型", confidence: "Demo",
  },
  {
    definition_id: "preview-al-status", profile: "ET1100", source_chip: "ET1100",
    address: 0x0130, address_text: "0x0130", address_space: "esc_core", address_space_label: "ESC Core",
    size: 2, width: 2, name: "AL Status", group: "状态机", access: "RO", master_access: "RO",
    master_access_allowed: true, direct_read_allowed: true, direct_write_allowed: false,
    description: "当前 EtherCAT AL 状态", confidence: "Demo",
  },
  {
    definition_id: "preview-al-status-code", profile: "ET1100", source_chip: "ET1100",
    address: 0x0134, address_text: "0x0134", address_space: "esc_core", address_space_label: "ESC Core",
    size: 2, width: 2, name: "AL Status Code", group: "状态机", access: "RO", master_access: "RO",
    master_access_allowed: true, direct_read_allowed: true, direct_write_allowed: false,
    description: "最近一次 AL 错误码", confidence: "Demo",
  },
  {
    definition_id: "preview-invalid-frame-counter", profile: "ET1100", source_chip: "ET1100",
    address: 0x0300, address_text: "0x0300", address_space: "esc_core", address_space_label: "ESC Core",
    size: 8, width: 8, name: "Invalid Frame Counter", group: "链路诊断", access: "RO", master_access: "RO",
    master_access_allowed: true, direct_read_allowed: true, direct_write_allowed: false,
    description: "各端口无效帧计数", confidence: "Demo",
  },
];

class PreviewBridge {
  hostGeneration = 1;
  mode: Mode = "demo";
  connected = false;
  running = false;
  scanned: SlaveInfo[] = [];
  handlers = new Set<Handler>();
  sessionId = 0;
  revision = 0;
  adapter = "preview0";

  advanceSession() {
    this.sessionId += 1;
    this.revision += 1;
  }

  snapshot(): WorkbenchStatus {
    return {
      host_generation: this.hostGeneration,
      mode: this.mode,
      phase: this.running ? "cyclic" : this.connected ? this.scanned.length ? "bus_scanned" : "adapter_open" : "disconnected",
      adapter: this.connected ? this.adapter : undefined,
      connected: this.connected,
      cycle_running: this.running,
      slaves: structuredClone(this.scanned),
      session_id: this.sessionId,
      revision: this.revision,
      worker_healthy: true,
      worker_state: "ready",
      queue_depth: 0,
    };
  }

  emit(kind: string, data: unknown) {
    this.handlers.forEach((handler) => handler({
      kind,
      data,
      host_generation: this.hostGeneration,
      session_id: this.sessionId,
    }));
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, method === "scan" || method === "auto_scan" ? 450 : 120));
    switch (method) {
      case "status":
        return this.snapshot() as T;
      case "switch_mode":
        this.mode = String(params.mode) as Mode;
        this.connected = false;
        this.running = false;
        this.scanned = [];
        this.advanceSession();
        return { mode: this.mode } as T;
      case "enumerate_adapters":
        return [{ name: "preview0", description: "Intel(R) Ethernet Controller I225-V" }] as T;
      case "auto_scan": {
        const adapters = [{ name: "preview0", description: "Intel(R) Ethernet Controller I225-V" }];
        this.connected = true;
        this.scanned = structuredClone(demoSlaves);
        this.advanceSession();
        return {
          adapters,
          selected_adapter: "preview0",
          connected: true,
          slaves: this.scanned,
          attempts: [{ adapter: "preview0", slave_count: this.scanned.length, elapsed_ms: 0 }],
        } satisfies AutoScanResult as T;
      }
      case "connect":
        this.connected = true;
        this.scanned = [];
        this.advanceSession();
        return { connected: true } as T;
      case "disconnect":
        this.connected = false;
        this.running = false;
        this.scanned = [];
        this.advanceSession();
        return { connected: false } as T;
      case "scan":
        this.scanned = structuredClone(demoSlaves);
        this.advanceSession();
        return this.scanned as T;
      case "read_states":
        return this.scanned as T;
      case "request_state": {
        const position = Number(params.position ?? 0);
        const state = Number(params.state);
        if (this.running || state === 8) {
          this.scanned = this.scanned.map((slave) => ({ ...slave, state: 4 }));
        }
        this.running = state === 8;
        this.scanned = this.scanned.map((slave) =>
          position === 0 || position === slave.position ? { ...slave, state } : slave,
        );
        this.emit("slaves_changed", this.scanned);
        return this.scanned as T;
      }
      case "object_dictionary":
        return [
          { index: 0x1000, subindex: 0, name: "Device type", data_type: "UNSIGNED32", bit_length: 32, access: "RO", source: "online" },
          { index: 0x1018, subindex: 1, name: "Vendor ID", data_type: "UNSIGNED32", bit_length: 32, access: "RO", source: "online" },
          { index: 0x6040, subindex: 0, name: "Controlword", data_type: "UNSIGNED16", bit_length: 16, access: "RW", source: "online" },
        ] as T;
      case "sdo_read":
        return { data: "11 22 33 44" } as T;
      case "sdo_write":
        return { data: params.data, readback: params.data, verified: true } as T;
      case "pdo_mapping":
        return {
          rx: [{ direction: "rx", pdo_index: 0x1600, index: 0x7000, subindex: 1, bit_length: 8, bit_offset: 0, name: "Outputs", data_type: "UNSIGNED8" }],
          tx: [{ direction: "tx", pdo_index: 0x1a00, index: 0x6000, subindex: 1, bit_length: 16, bit_offset: 0, name: "Inputs", data_type: "UNSIGNED16" }],
        } as T;
      case "start_cycle":
        this.running = true;
        this.scanned = this.scanned.map((slave) => ({ ...slave, state: 8 }));
        this.revision += 1;
        this.emit("cycle_started", this.scanned);
        window.setTimeout(() => this.emit("process_data", {
          inputs: ["34 12", "", "08 00 00 00"], outputs: ["", "01", "0F 00 00 00"],
          actual_wkc: 6, expected_wkc: 6, cycle_count: 18420, timeout_count: 0,
          wkc_error_count: 0, consecutive_errors: 0, timestamp: Date.now() / 1000,
        }), 250);
        return { running: true } as T;
      case "stop_cycle":
        this.running = false;
        this.scanned = this.scanned.map((slave) => ({ ...slave, state: 4 }));
        this.revision += 1;
        this.emit("cycle_stopped", this.scanned);
        return { running: false, slaves: this.scanned } as T;
      case "set_output":
        return { applied: true, data: params.data } as T;
      case "register_catalog":
        return structuredClone(previewRegisterDefinitions) as T;
      case "register_definition": {
        const definition = previewRegisterDefinitions.find(
          (item) => item.definition_id === String(params.definition_id ?? ""),
        );
        if (!definition) throw new Error("预览寄存器定义不存在");
        return structuredClone(definition) as T;
      }
      case "register_read":
        return { position: params.position, address: params.address, data: "08 00", wkc: 1, duration_ms: 0.38, timestamp: Date.now() / 1000 } as T;
      case "register_watch": {
        const requests = Array.isArray(params.requests) ? params.requests as Array<Record<string, unknown>> : [];
        return requests.map((request) => ({
          position: params.position,
          address: request.address,
          data: Number(request.size ?? 2) === 1 ? "08" : "08 00",
          wkc: 1,
          duration_ms: 0.31,
          timestamp: Date.now() / 1000,
        })) as T;
      }
      case "register_prepare_write":
        return {
          plan_id: "preview-register-plan",
          plan: { current: "00 00", target: params.data, changed_mask: "FF FF" },
          expires_in_seconds: 60,
        } as T;
      case "register_execute_write":
        return { fpwr_wkc: 1, readback: "01 00", verified: true, conclusion: "写入后回读一致" } as T;
      case "register_reset":
        this.scanned = [];
        this.advanceSession();
        return { reset_sequence: [true, true, true] } as T;
      case "esi_library_list":
        return {
          directory: "D:\\EtherCAT Workbench\\xml列表",
          errors: [],
          entries: [
            { path: "D:\\EtherCAT Workbench\\xml列表\\Demo-IO-SPI.xml", sha256: "preview-spi", vendor_id: 2, vendor_name: "Demo Automation", ordinal: 0, device_name: "Demo EtherCAT Device · SPI", type_name: "Demo-IO", product_code: 0x12345678, revision: 0x00010000, byte_size: 2048, config_data: "05 0E 03 44 0A 00 00 00 00 00" },
            { path: "D:\\EtherCAT Workbench\\xml列表\\Demo-IO-HBI.xml", sha256: "preview-hbi", vendor_id: 2, vendor_name: "Demo Automation", ordinal: 0, device_name: "Demo EtherCAT Device · HBI", type_name: "Demo-IO", product_code: 0x12345678, revision: 0x00010000, byte_size: 2048, config_data: "8D 0E 03 44 0A 00 00 00 00 00" },
          ],
        } as T;
      case "esi_load": {
        const hbi = String(params.path ?? "").toLowerCase().includes("hbi");
        const device: EsiDevice = { name: hbi ? "Demo EtherCAT Device · HBI" : "Demo EtherCAT Device · SPI", type_name: "Demo-IO", product_code: 0x12345678, revision_number: 0x00010000, serial_number: 0, eeprom_byte_size: 2048, config_data: hbi ? "8D 0E 03 44 0A 00 00 00 00 00" : "05 0E 03 44 0A 00 00 00 00 00" };
        return { document_id: "preview-document", path: params.path, sha256: "preview", vendor_id: 2, vendor_name: "Demo Automation", devices: [device] } as T;
      }
      case "sii_generate": {
        const configData = String(params.config_data ?? "05 0E 03 44 0A 00 00 00 00 00");
        return { target_id: `preview-target-${configData.replaceAll(" ", "")}`, size: 2048, sha256: "9f3b…d120", supported: ["Identity", "Strings", "PDO", "FMMU", "SyncM"], omitted: ["Vendor category 0x9000"], layout: [{ name: "Fixed SII area", offset: 0, length: 128, content: `${configData} 00 00 00 00 B6 00` }, { kind: 0x000A, name: "Strings", offset: 128, length: 42, content: "02 0B 44 65 6D 6F" }, { kind: 0xFFFF, name: "End marker", offset: 512, length: 2, content: "FF FF" }], device: { name: "Demo EtherCAT Device", product_code: 0x12345678, revision_number: 0x10000, config_data: configData }, original_config_data: "05 0E 03 44 0A 00 00 00 00 00", effective_config_data: configData } as T;
      }
      case "eeprom_header":
        return { header: "05 0E 03 44 0A 00 00 00 00 00 00 00 00 00 B6 00", config_data: "05 0E 03 44 0A 00 00 00 00 00", crc_valid: true, size: 2048 } as T;
      case "eeprom_read":
        return {
          data: "FF ".repeat(2048).trim(),
          size: 2048,
          sha256: "9f3b…d120",
          read_at: new Date().toISOString(),
          sii_valid: true,
          identity: { vendor_id: 2, product_code: 0x12345678, revision: 0x00010000, serial_number: 0 },
          category_count: 6,
          categories: [10, 30, 40, 41, 42, 50],
          end_offset: 1536,
          comparison: {
            equal: true,
            differing_bytes: 0,
            target_sha256: "9f3b…d120",
            readback_sha256: "9f3b…d120",
          },
        } as T;
      case "eeprom_capacity":
        return { size: 2048 } as T;
      case "eeprom_backup":
        return { binary_path: `${params.directory}\\slave-2-eeprom.bin`, size: 2048, sha256: "6ad4…51c2" } as T;
      case "eeprom_flash":
      case "eeprom_restore":
        this.scanned = this.scanned.map((slave) => slave.position === Number(params.position) ? { ...slave, state: 1 } : slave);
        this.emit("slaves_changed", this.scanned);
        this.emit("progress", { operation: "eeprom-flash", stage: "prepare-init", completed: 1, total: 1, detail: "目标从站已切换到 INIT", cancellable: false });
        for (const completed of [10, 35, 68, 100]) {
          this.emit("progress", { operation: "eeprom-flash", stage: completed < 100 ? "write-verify" : "full-verify", completed, total: 100, detail: `${completed}%`, cancellable: false });
        }
        if (params.auto_reset !== false) this.advanceSession();
        return {
          success: true,
          result: {
            bytes_read_back: 2048,
            words_written: 1024,
            comparison: {
              equal: true,
              differing_bytes: 0,
              target_sha256: "9f3b…d120",
              readback_sha256: "9f3b…d120",
            },
            sii_valid: true,
            semantic_valid: true,
            image_verification: "完整镜像与语义校验通过",
            reset_sequence: params.auto_reset === false ? null : [true, true, true],
            rediscovered: params.auto_reset === false ? null : true,
            reload_verified: params.auto_reset === false ? null : true,
          },
          slaves: this.scanned,
        } as T;
      case "cancel":
        return { cancelled: true } as T;
      default:
        return {} as T;
    }
  }
}

const preview = new PreviewBridge();

export class BridgeRequestError extends Error {
  readonly code: string;
  readonly failure: ReturnType<typeof normalizeBridgeFailure>;

  constructor(failure: ReturnType<typeof normalizeBridgeFailure>) {
    super(failure.message);
    this.name = "BridgeRequestError";
    this.code = failure.code;
    this.failure = failure;
  }
}

export async function bridgeRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const operation = operationStore.begin(method);
  operationStore.transition(operation.id, "running");
  try {
    if (!isTauri) {
      const value = await preview.request<T>(method, params);
      publishSnapshot(preview.snapshot(), operation.id);
      const current = operationStore.get(operation.id);
      if (current?.phase !== "running") throw current?.error ?? new Error("操作上下文已失效");
      operationStore.transition(operation.id, "completed");
      return value;
    }
    const envelope = await invoke<BridgeEnvelope<T>>("bridge_request", { method, params, sessionId: operation.sessionId });
    publishSnapshot(envelope.snapshot, operation.id);
    const current = operationStore.get(operation.id);
    if (current?.phase !== "running") throw current?.error ?? new Error("操作上下文已失效");
    operationStore.transition(operation.id, "completed");
    return envelope.result;
  } catch (error) {
    if (error && typeof error === "object" && "snapshot" in error) {
      publishSnapshot((error as { snapshot?: WorkbenchStatus }).snapshot, operation.id);
    }
    const failure = normalizeBridgeFailure(error);
    operationStore.transition(operation.id, failure.operation_result === "unknown" ? "unknown" : failure.code === "CANCELLED" ? "cancelled" : "failed", failure);
    if (failure.session_invalidated) operationStore.invalidate(failure.code, failure.message);
    throw new BridgeRequestError(failure);
  }
}

export async function onBridgeEvent(handler: Handler): Promise<UnlistenFn> {
  if (!isTauri) {
    preview.handlers.add(handler);
    return () => preview.handlers.delete(handler);
  }
  const bridgeEvent = await listen<BridgeEvent>("bridge-event", (event) => {
    if (event.payload.kind === "bus_snapshot") {
      const snapshot = event.payload.data as WorkbenchStatus;
      publishSnapshot({
        ...snapshot,
        host_generation: snapshot.host_generation ?? event.payload.host_generation ?? 0,
      });
      return;
    }
    if (!acceptsSessionEvent(latestSnapshot, event.payload)) return;
    handler(event.payload);
  });
  const restarted = await listen<{ host_generation: number }>("bridge-restarted", (event) =>
    handler({ kind: "host_ready", data: event.payload })
  );
  const restartFailed = await listen<{ host_generation: number; message: string }>("bridge-restart-failed", (event) =>
    handler({ kind: "host_restart_failed", data: event.payload })
  );
  return () => { bridgeEvent(); restarted(); restartFailed(); };
}

export async function onBridgeExited(handler: (info: BridgeExitInfo) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const receive = (payload: BridgeExitInfo | string) => {
    const info = typeof payload === "string"
      ? { message: payload, reason: "旧版桥接未提供退出详情" }
      : payload;
    operationStore.invalidate("PROCESS_EXITED", info.message);
    publishHostFault(info.message, info.host_generation);
    handler(info);
  };
  const exited = await listen<BridgeExitInfo | string>("bridge-exited", (event) => receive(event.payload));
  const stalled = await listen<{ message: string }>("bridge-stalled", (event) => receive({ ...event.payload, reason: "heartbeat_timeout" }));
  return () => { exited(); stalled(); };
}

export async function onFileDrop(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths);
  });
}

export async function pickFile(extensions: string[]): Promise<string | null> {
  if (!isTauri) return `C:\\EtherCAT\\device.${extensions[0]}`;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, filters: [{ name: "支持的文件", extensions }] });
  return typeof selected === "string" ? selected : null;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri) return "C:\\EtherCAT\\Backups";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function revealPath(path: string): Promise<void> {
  if (!isTauri) return;
  await invoke("reveal_path", { path });
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_external", { url });
}

export const previewMode = !isTauri;
export type { AdapterInfo, WorkbenchStatus };
