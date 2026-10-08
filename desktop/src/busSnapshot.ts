import type { WorkbenchStatus } from "./types";

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalValue(a[key], b[key]));
}

// Keep unchanged device references, but include clocks, telemetry and faults in equality.
export function reconcileBusSnapshot(current: WorkbenchStatus | undefined, incoming: WorkbenchStatus): WorkbenchStatus {
  if (!current || current.host_generation !== incoming.host_generation || current.session_id !== incoming.session_id) return incoming;
  const byPosition = new Map(current.slaves.map((slave) => [slave.position, slave]));
  const slaves = incoming.slaves.map((slave) => {
    const previous = byPosition.get(slave.position);
    return previous && equalValue(previous, slave) ? previous : slave;
  });
  const unchangedSlaves = slaves.length === current.slaves.length && slaves.every((slave, index) => slave === current.slaves[index]);
  const next = { ...incoming, slaves: unchangedSlaves ? current.slaves : slaves };
  return equalValue(current, next) ? current : next;
}
