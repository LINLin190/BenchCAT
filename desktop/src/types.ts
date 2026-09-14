export type Mode = "real" | "demo";
export type MasterPhase = "disconnected" | "adapter_open" | "bus_scanned" | "pdo_configured" | "cyclic" | "faulted";

export interface AdapterInfo {
  name: string;
  description: string;
  volatile?: boolean;
}

export interface SlaveIdentity {
  vendor_id: number;
  product_code: number;
  revision: number;
  serial_number: number;
}

export interface SlaveInfo {
  position: number;
  name: string;
  identity: SlaveIdentity;
  state: number;
  al_status: number;
  input_size: number | null;
  output_size: number | null;
  configured_address?: number;
  chip_model: string;
  register_family: string;
  raw_state?: number | null;
  pdi_type?: number | null;
  pdo_size_source?: "mapped" | "cache" | "sii" | "unknown";
  esc_hardware?: string | null;
  esc_hardware_error?: string | null;
}

export interface WorkbenchStatus {
  host_generation: number;
  mode: Mode;
  phase: MasterPhase;
  adapter?: string | null;
  connected: boolean;
  cycle_running: boolean;
  slaves: SlaveInfo[];
  worker_healthy?: boolean;
  worker_state?: string;
  queue_depth?: number;
  session_id: number;
  revision: number;
  last_error?: string | null;
}

export interface AutoScanAttempt {
  adapter: string;
  slave_count: number;
  elapsed_ms: number;
  timed_out?: boolean;
  error?: string;
  disconnect_error?: string;
}

export interface AutoScanResult {
  adapters: AdapterInfo[];
  selected_adapter: string;
  connected: boolean;
  slaves: SlaveInfo[];
  attempts: AutoScanAttempt[];
}

export interface BridgeEvent<T = unknown> {
  kind: string;
  data: T;
  host_generation?: number;
  session_id?: number;
}

export interface BridgeExitInfo {
  message: string;
  reason: string;
  exit_code?: number;
  stderr_tail?: string;
  log_path?: string;
  last_request_id?: number;
  last_method?: string;
  host_generation?: number;
}

export interface PdoEntry {
  direction: "rx" | "tx";
  pdo_index: number;
  index: number;
  subindex: number;
  bit_length: number;
  bit_offset: number;
  name?: string;
  data_type?: string;
}

export interface RegisterDefinition {
  definition_id?: string;
  profile?: string;
  source_chip?: string;
  address: number;
  address_text?: string;
  address_space?: string;
  address_space_label?: string;
  size?: number;
  width?: number;
  width_bits?: number;
  name: string;
  group: string;
  access: string;
  master_access?: string;
  master_access_allowed?: boolean;
  direct_read_allowed?: boolean;
  direct_write_allowed?: boolean;
  dangerous?: boolean;
  description: string;
  reset_value?: string;
  power_on_default?: string;
  state_restriction?: string;
  hardware_condition?: string;
  reserved_bits_rule?: string;
  byte_order?: string;
  read_side_effects?: string[];
  write_side_effects?: string[];
  write_sequence?: string;
  confidence?: string;
  fields?: { bits: string; name: string; ecat_access?: string; access?: string; reserved?: boolean; description?: string; reset_value?: string }[];
  bit_fields?: { name: string; shift: number; bits: number; access?: string; reserved?: boolean; description?: string }[];
}

export interface OperationProgress {
  operation: string;
  stage: string;
  completed: number;
  total: number;
  detail: string;
  cancellable?: boolean;
}

export interface EsiDevice {
  ordinal?: number;
  name: string;
  type_name: string;
  product_code: number;
  revision?: number;
  revision_number?: number;
  serial_number: number;
  group_type?: string;
  eeprom_byte_size?: number;
  byte_size?: number;
  config_data?: string;
  [key: string]: unknown;
}

export const stateLabel = (state: number) =>
  ({ 0: "NONE", 1: "INIT", 2: "PRE-OP", 3: "BOOT", 4: "SAFE-OP", 8: "OP" })[state] ??
  `0x${state.toString(16).toUpperCase()}`;

export const hex = (value: number, width = 4) =>
  `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
