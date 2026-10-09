import { stateLabel, type SlaveInfo } from "./types";

export function isSlaveStateUnknown(slave: SlaveInfo): boolean {
  return Boolean(slave.state_error) || slave.state === 0;
}

export function isSlaveStateHealthy(slave: SlaveInfo): boolean {
  return !isSlaveStateUnknown(slave) && !slave.al_status && !((slave.raw_state ?? slave.state) & 0x10);
}

export function slaveStateLabel(slave: SlaveInfo): string {
  if (isSlaveStateUnknown(slave)) return "未知状态";
  return stateLabel(slave.state) + ((slave.raw_state ?? slave.state) & 0x10 ? " + ERROR" : "");
}

export function currentAlCode(slave: SlaveInfo): number | undefined {
  return slave.state_error ? slave.observed_al_status ?? undefined : slave.al_status;
}

export function showSlaveIoSizes(slave: SlaveInfo, stateRequestFailed: boolean): boolean {
  return !isSlaveStateUnknown(slave) && !stateRequestFailed
    && !((slave.raw_state ?? slave.state) & 0x10) && slave.al_status === 0;
}
