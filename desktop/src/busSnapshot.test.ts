import { describe, expect, it } from "vitest";
import { reconcileBusSnapshot } from "./busSnapshot";
import type { SlaveInfo, WorkbenchStatus } from "./types";

const slave: SlaveInfo = { position: 1, name: "Device", identity: { vendor_id: 2, product_code: 1, revision: 1, serial_number: 0 }, state: 2, al_status: 0, input_size: 0, output_size: 0, chip_model: "LAN9252", register_family: "LAN9252", scan_errors: [] };
const snapshot = (): WorkbenchStatus => ({ host_generation: 1, session_id: 2, revision: 3, mode: "real", phase: "bus_scanned", connected: true, cycle_running: false, slaves: [structuredClone(slave)], worker_healthy: true, queue_depth: 0 });

describe("bus snapshot reconciliation", () => {
  it("reuses an identical snapshot and its slave references", () => {
    const current = snapshot();
    expect(reconcileBusSnapshot(current, snapshot())).toBe(current);
  });

  it("retains unchanged slaves when only the revision or queue changes", () => {
    const current = snapshot();
    const next = reconcileBusSnapshot(current, { ...snapshot(), revision: 4, queue_depth: 1 });
    expect(next).not.toBe(current);
    expect(next.slaves).toBe(current.slaves);
    expect(next.revision).toBe(4);
    expect(next.queue_depth).toBe(1);
  });

  it("publishes faults even when clocks are unchanged", () => {
    const current = snapshot();
    const next = reconcileBusSnapshot(current, { ...snapshot(), last_error: "worker exited", worker_healthy: false, phase: "faulted" });
    expect(next).not.toBe(current);
    expect(next.last_error).toBe("worker exited");
    const incoming = snapshot();
    incoming.slaves[0].scan_errors = ["EEPROM unreadable"];
    expect(reconcileBusSnapshot(current, incoming).slaves[0]).not.toBe(current.slaves[0]);
  });

  it("replaces references across sessions and host generations", () => {
    const current = snapshot();
    for (const incoming of [{ ...snapshot(), session_id: 3 }, { ...snapshot(), host_generation: 2 }]) {
      expect(reconcileBusSnapshot(current, incoming)).toBe(incoming);
      expect(incoming.slaves[0]).not.toBe(current.slaves[0]);
    }
  });
});
