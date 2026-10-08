import { bridgeRequest } from "./api";
import type { AdapterInfo, AutoScanResult, WorkbenchStatus } from "./types";

interface StartupHandlers {
  preferredAdapter: () => string;
  onAdapters: (adapters: AdapterInfo[], selected?: string) => void;
  onScan: (result: AutoScanResult) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string | undefined) => void;
}

// Admission and device discovery have separate completion points.
export function createBridgeStartup(handlers: StartupHandlers) {
  let active = true;
  let subscribed = false;
  let generation: number | undefined;
  let completedGeneration: number | undefined;
  let inFlight = false;
  let pending = false;

  const initialize = async (reloadAdapters = false) => {
    if (!active || !subscribed || generation === undefined
      || (!reloadAdapters && completedGeneration === generation)) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    pending = false;
    const expectedGeneration = generation;
    const isCurrent = () => active && generation === expectedGeneration;
    let stage = "读取设备状态";
    let receivedGeneration: number | undefined;
    handlers.onLoading(true);
    handlers.onError(undefined);
    try {
      const status = await bridgeRequest<WorkbenchStatus>("status");
      if (!isCurrent()) return;
      receivedGeneration = status.host_generation;
      // Browser SSE admission has no host clock until the first status response.
      if (expectedGeneration > 0 && receivedGeneration !== expectedGeneration) {
        throw new Error(`通信核心代次不一致（预期 ${expectedGeneration}，收到 ${receivedGeneration}）`);
      }
      if (!status.connected && !reloadAdapters) {
        stage = "自动扫描网卡和从站";
        const result = await bridgeRequest<AutoScanResult>("auto_scan", { preferred_adapter: handlers.preferredAdapter() });
        if (!isCurrent()) return;
        handlers.onAdapters(result.adapters, result.selected_adapter || undefined);
        handlers.onScan(result);
      } else {
        stage = "加载网卡列表";
        const adapters = await bridgeRequest<AdapterInfo[]>("enumerate_adapters");
        if (!isCurrent()) return;
        handlers.onAdapters(adapters, status.adapter ?? undefined);
      }
      if (isCurrent()) completedGeneration = expectedGeneration;
    } catch (error) {
      if (!isCurrent()) return;
      console.error("Bridge device initialization failed", { stage, expectedGeneration, receivedGeneration, error });
      handlers.onError("无法加载网卡，请重新加载网卡；如仍无法使用，请重启软件。");
    } finally {
      inFlight = false;
      if (isCurrent()) handlers.onLoading(false);
      if (active && pending) { pending = false; void initialize(); }
    }
  };

  return {
    ready(value: number) {
      if (!active || (generation !== undefined && value <= generation)) return false;
      generation = value;
      completedGeneration = undefined;
      handlers.onLoading(true);
      void initialize();
      return true;
    },
    subscribed() { subscribed = true; void initialize(); },
    unavailable() {
      generation = undefined;
      completedGeneration = undefined;
      pending = false;
      handlers.onLoading(false);
    },
    reloadAdapters() { void initialize(true); },
    dispose() { active = false; generation = undefined; pending = false; },
  };
}
