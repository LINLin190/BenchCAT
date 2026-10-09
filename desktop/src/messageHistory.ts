export type MessageResult = "started" | "success" | "error" | "warning" | "info" | "cancelled" | "unknown" | "recovered";
export interface HistoryMessage {
  id: number;
  time: number;
  operation: string;
  result: MessageResult;
  text: string;
  context?: string;
  details?: string[];
  operationId?: string;
  durationMs?: number;
  reason?: string;
  wkc?: { label: string; actual: number; expected: number }[];
  repeatKey?: string;
  repeatCount: number;
  firstTime: number;
  lastEvent: number;
}
export type MessageInput = Omit<HistoryMessage, "id" | "time" | "repeatCount" | "firstTime" | "lastEvent">;
export const HISTORY_LIMIT = 300;
export const resultLabels: Record<MessageResult, string> = { started: "开始", success: "成功", error: "错误", warning: "警告", info: "信息", cancelled: "已取消", unknown: "未确认", recovered: "恢复" };

// Intentionally memory-only: a new application process starts with an empty history.
export function createMessageHistory() {
  let sequence = 0;
  let readThrough = 0;
  let viewing = false;
  const repeats = new Map<string, number>();
  let snapshot: { entries: readonly HistoryMessage[]; unread: number; unreadErrors: number } = { entries: [], unread: 0, unreadErrors: 0 };
  const listeners = new Set<() => void>();
  const publish = (entries: readonly HistoryMessage[]) => {
    const unread = entries.filter(entry => entry.lastEvent > readThrough && entry.result !== "recovered");
    snapshot = { entries, unread: unread.length, unreadErrors: unread.filter(entry => entry.result === "error").length };
    const retained = new Set(entries.map(entry => entry.id));
    for (const [key, id] of repeats) if (!retained.has(id)) repeats.delete(key);
    listeners.forEach(listener => listener());
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    append(input: MessageInput) {
      if (input.result !== "error" && input.result !== "warning" && input.result !== "unknown" && input.result !== "recovered") {
        if (input.repeatKey && input.result === "success") repeats.delete(input.repeatKey);
        return;
      }
      // Keep the primary line brief; long fault text remains available on demand.
      const separator = input.text.search(/[；。\n]/);
      if (separator > 0 && !input.reason) {
        const original = input.text;
        const reason = original.slice(separator + 1).trim().replace(/。$/, "");
        input = { ...input, text: original.slice(0, separator).trim(), reason: reason || undefined,
          details: [...new Set([...(input.details ?? []), ...(reason.length > 60 ? [original] : [])])] };
      }
      const result = input.result === "unknown" ? "warning" : input.result;
      const previous = input.repeatKey ? snapshot.entries.find(entry => entry.id === repeats.get(input.repeatKey!)) : undefined;
      // Only automatic observations opt into merging; explicit operations remain separate.
      const sameFault = previous && previous.result === result && previous.text === input.text && previous.context === input.context
        && previous.reason === input.reason && JSON.stringify(previous.details) === JSON.stringify(input.details);
      const time = Date.now(), lastEvent = ++sequence;
      const entry: HistoryMessage = { ...input, result, details: input.details ? [...input.details] : undefined,
        wkc: input.wkc?.map(value => ({ ...value })), id: sameFault ? previous.id : lastEvent, time, lastEvent,
        firstTime: sameFault ? previous.firstTime : time, repeatCount: sameFault ? previous.repeatCount + 1 : 1 };
      if (input.repeatKey) repeats.set(input.repeatKey, entry.id);
      if (viewing) readThrough = sequence;
      publish([entry, ...snapshot.entries.filter(item => item.id !== entry.id)].slice(0, HISTORY_LIMIT));
      return entry;
    },
    endRepeat(key: string) { repeats.delete(key); },
    setViewing(value: boolean) { viewing = value; if (value) { readThrough = sequence; publish(snapshot.entries); } },
    clear() { readThrough = sequence; repeats.clear(); publish([]); },
  };
}
export const messageHistory = createMessageHistory();

export function messageTime(time: number, now = Date.now(), full = false): string {
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const clock = date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return full || !sameDay ? `${day} ${clock}` : clock;
}
export function copyMessage(entry: HistoryMessage): string {
  return [...new Set([`${messageTime(entry.time, Date.now(), true)} · ${entry.operation} · ${resultLabels[entry.result]}`, entry.text, entry.context, entry.reason,
    ...(entry.wkc ?? []).map(value => `${value.label}：实际 ${value.actual} / 期望 ${value.expected}`),
    entry.repeatCount > 1 ? `重复 ${entry.repeatCount} 次；首次 ${messageTime(entry.firstTime, Date.now(), true)}` : undefined,
    ...(entry.details ?? [])].filter(Boolean))].join("\n");
}
