import { beforeEach, describe, expect, it, vi } from "vitest";

let operationStore: typeof import("./operationStore").operationStore;

beforeEach(async () => {
  vi.resetModules();
  ({ operationStore } = await import("./operationStore"));
});

describe("operation store lifecycle boundaries", () => {
  it("keeps activity stable for metadata and running transitions", () => {
    const listener = vi.fn();
    operationStore.subscribeActivity(listener);
    const idle = operationStore.activitySnapshot();
    const metadata = operationStore.begin("register_catalog");
    operationStore.transition(metadata.id, "running");
    operationStore.transition(metadata.id, "completed");
    expect(operationStore.activitySnapshot()).toBe(idle);
    expect(listener).not.toHaveBeenCalled();

    const hardware = operationStore.begin("register_read");
    const busy = operationStore.activitySnapshot();
    expect(busy.hardwareBusy).toBe(true);
    operationStore.transition(hardware.id, "running");
    expect(operationStore.activitySnapshot()).toBe(busy);
    operationStore.transition(hardware.id, "completed");
    expect(operationStore.activitySnapshot().hardwareBusy).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps overlapping hardware work busy and excludes cancellable register snapshots from disconnect", () => {
    const first = operationStore.begin("register_snapshot");
    const second = operationStore.begin("register_snapshot");
    expect(operationStore.activitySnapshot()).toMatchObject({ hardwareBusy: true, disconnectHardwareBusy: false });
    operationStore.transition(first.id, "completed");
    expect(operationStore.activitySnapshot().hardwareBusy).toBe(true);
    operationStore.transition(second.id, "failed");
    const state = operationStore.begin("request_state");
    expect(operationStore.activitySnapshot()).toMatchObject({ stateRequestBusy: true, hardwareBusy: false });
    operationStore.transition(state.id, "cancelled");
    const scan = operationStore.begin("auto_scan");
    expect(operationStore.activitySnapshot()).toMatchObject({ scanning: true, hardwareBusy: true, disconnectHardwareBusy: true });
    operationStore.invalidate("HOST_EXITED", "exited");
    expect(operationStore.activitySnapshot().scanning).toBe(false);
    expect(operationStore.get(scan.id)?.phase).toBe("failed");
  });

  it("invalidates the old page request but not a request started after navigation", () => {
    const oldRequest = operationStore.begin("register_catalog");
    operationStore.transition(oldRequest.id, "running");

    operationStore.nextPage();
    expect(operationStore.get(oldRequest.id)?.phase).toBe("failed");

    const newRequest = operationStore.begin("register_catalog");
    operationStore.transition(newRequest.id, "running");
    expect(operationStore.get(newRequest.id)?.phase).toBe("running");
  });

  it("keeps the response source alive when a replacement host generation arrives", () => {
    operationStore.setSnapshotClock(1, 1);
    const status = operationStore.begin("status");
    const registerRead = operationStore.begin("register_read");
    operationStore.transition(status.id, "running");
    operationStore.transition(registerRead.id, "running");

    operationStore.setSnapshotClock(2, 0, status.id);

    expect(operationStore.get(status.id)?.phase).toBe("running");
    expect(operationStore.get(registerRead.id)?.phase).toBe("failed");
  });
});
