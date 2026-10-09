import { describe, expect, it } from "vitest";
import { normalizeBridgeFailure } from "./operationStore";
import { currentAlCode, slaveStateLabel } from "./slaveState";
import type { SlaveInfo } from "./types";

const slave: SlaveInfo = {
  position: 1, name: "ET1100", identity: { vendor_id: 1, product_code: 2, revision: 3, serial_number: 0 },
  state: 2, raw_state: 2, al_status: 0x11, input_size: 0, output_size: 0,
  chip_model: "ET1100", register_family: "ET1100_COMPATIBLE",
};

describe("slave state observations", () => {
  it("shows invalid responding data separately from the cached PRE-OP state", () => {
    const invalid: SlaveInfo = { ...slave, raw_state: 0x1600, observed_al_status: 0x1600,
      state_error: "AL 状态值无效", state_error_kind: "invalid_state", last_confirmed_state: 2 };
    expect(slaveStateLabel(invalid)).toBe("未知状态");
    expect(currentAlCode(invalid)).toBe(0x1600);
    expect(slaveStateLabel({ ...slave, raw_state: 0x12 })).toBe("PRE-OP + ERROR");
  });

  it("does not present a cached AL code as a current read after no response", () => {
    const missing: SlaveInfo = { ...slave, raw_state: null, state_error: "无响应", state_error_kind: "no_response" };
    expect(slaveStateLabel(missing)).toBe("未知状态");
    expect(currentAlCode(missing)).toBeUndefined();
    expect(slaveStateLabel({ ...missing, state_error_kind: "read_failed" })).toBe("未知状态");
    expect(slaveStateLabel({ ...missing, state_error_kind: "link_disconnected" })).toBe("未知状态");
    expect(currentAlCode(slave)).toBe(0x11);
  });

  it("retains the operation phase and historical readings across error normalization", () => {
    const details = { phase: "pdo_mapping", target: 4, positions: [1], initial_states: { "1": 2 },
      observations: [{ position: 1, raw_state: 2, al_status: 0 }], cause: "config_map failed" };
    expect(normalizeBridgeFailure({ code: "STATE_REQUEST_FAILED", message: "PDO 配置失败",
      category: "configuration", details })).toMatchObject({ category: "configuration", details });
  });
});
