import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box, Button, IconButton, LinearProgress, Paper, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import { CheckCircleOutlineRounded, CloseRounded, ErrorOutlineRounded, InfoOutlined, NotificationsNoneRounded, WarningAmberRounded } from "@mui/icons-material";
import type { HistoryMessage } from "./messageHistory";

type Severity = "success" | "error" | "info" | "warning";
export interface DockMessage { id: number; text: string; severity: Severity; historyId?: number }
export interface DockProgress {
  key: string;
  title: string;
  detail: string;
  severity: Severity;
  percent?: number;
  running: boolean;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}
interface Notice { key: string; title: string; detail: string; severity: Severity; historyId?: number }
interface ContentFrame extends Notice { width: number; progress?: DockProgress }
const dockSize = { collapsed: 108, minExpanded: 352, maxExpanded: 520, height: 36, noticeHeight: 64, progressHeight: 72 };
const minimumVisibleTime = 400;
const contentFadeTime = 220;
const dockEase = "cubic-bezier(.22,.8,.24,1)";
const priority = { info: 0, success: 0, warning: 1, error: 2 };
const duration = { info: 3000, success: 3000, warning: 6000, error: 8000 };
const colors = { info: "#66758F", success: "#3C8B69", warning: "#BF7C13", error: "#CF4555" };
const icon = { info: InfoOutlined, success: CheckCircleOutlineRounded, warning: WarningAmberRounded, error: ErrorOutlineRounded };

type DockMode = "idle" | "notice" | "history";

function useDockMorph(ref: RefObject<HTMLDivElement | null>, mode: DockMode, width: number, height: number, onSettled: (open: boolean) => void) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [settled, setSettled] = useState(true);
  const motion = useRef({ size: [dockSize.collapsed, dockSize.height, 18], velocity: [0, 0, 0], mode: "idle" as DockMode,
    holdUntil: 0, leavingHistory: false });
  const completion = useRef(onSettled);
  completion.current = onSettled;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const state = motion.current;
    const entering = mode !== "idle" && state.mode === "idle" && state.size[0] < dockSize.collapsed + 8;
    const leavingHistory = mode !== "history" && state.mode === "history";
    const retracting = (mode === "idle" && state.mode !== "idle") || leavingHistory;
    if (mode !== state.mode) {
      state.holdUntil = retracting ? performance.now() + 100 : 0;
      state.leavingHistory = leavingHistory;
    }
    state.mode = mode;
    const target = mode === "idle" ? [dockSize.collapsed, dockSize.height, 18] : [width, height, mode === "history" ? 12 : 24];
    const stiffness = mode === "history" ? 500 : state.leavingHistory ? 640 : 280;
    const damping = mode === "history" ? 42 : state.leavingHistory ? 48 : 28;
    const paint = () => ["width", "height", "radius"].forEach((name, index) => element.style.setProperty(`--dock-${name}`, `${state.size[index]}px`));
    if (reducedMotion || !entering && !retracting && target.every((value, axis) => value === state.size[axis] && state.velocity[axis] === 0)) {
      state.size = target; state.velocity = [0, 0, 0]; state.leavingHistory = false;
      paint(); setSettled(true); completion.current(mode === "history"); return;
    }
    setSettled(false);
    const started = performance.now();
    let previous = started, frame = 0;
    const step = (now: number) => {
      const elapsed = now - started;
      const delta = Math.min(32, now - previous) / 1000;
      previous = now;
      // Fade the contents before retraction; an interrupted spring keeps its velocity.
      if (now >= state.holdUntil) {
        const goal = entering && elapsed < 70 ? [dockSize.collapsed + 4, dockSize.height + 2, 19] : target;
        const slices = Math.max(1, Math.ceil(delta / 0.008)), dt = delta / slices;
        for (let slice = 0; slice < slices; slice++) {
          for (let axis = 0; axis < 3; axis++) {
            state.velocity[axis] += (stiffness * (goal[axis] - state.size[axis]) - damping * state.velocity[axis]) * dt;
            state.size[axis] += state.velocity[axis] * dt;
          }
        }
        paint();
        if (elapsed > 100 && target.every((value, axis) => Math.abs(value - state.size[axis]) < 0.08 && Math.abs(state.velocity[axis]) < 0.2)) {
          state.size = target; state.velocity = [0, 0, 0]; state.leavingHistory = false;
          paint(); setSettled(true); completion.current(mode === "history"); return;
        }
      }
      frame = requestAnimationFrame(step);
    };
    paint(); frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [ref, mode, width, height, reducedMotion]);
  return settled;
}

function fromHistory(entry: HistoryMessage): Notice {
  const diagnostics = entry.wkc?.map(value => `${value.label} ${value.actual} / ${value.expected}`).join(" · ");
  return { key: `history:${entry.id}`, title: entry.text, detail: [entry.context, diagnostics || entry.reason].filter(Boolean).join(" · "),
    severity: entry.result === "error" ? "error" : "warning", historyId: entry.id };
}

export function MessageDock({ entries, unread, unreadErrors, messages, onMessagesConsumed, progress, open, triggerRef, dockRef, onToggle, onShowRecord, children, onHistorySettled }: {
  entries: readonly HistoryMessage[]; unread: number; unreadErrors: number; messages: readonly DockMessage[]; onMessagesConsumed?: (throughId: number) => void; progress?: DockProgress; open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>; dockRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void; onShowRecord: (id: number) => void;
  children: ReactNode; onHistorySettled: (open: boolean) => void;
}) {
  const theme = useTheme();
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const [pending, setPending] = useState<Notice[]>([]);
  const [showNotice, setShowNotice] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissedProgress, setDismissedProgress] = useState<string>();
  const consumed = useRef({ event: entries[0]?.lastEvent ?? 0, toast: 0 });
  const announced = useRef(new Set(entries.map(entry => entry.id)));
  const current = useRef({ notice, showing: showNotice, pending });
  current.current = { notice, showing: showNotice, pending };
  const clock = useRef({ key: "", remaining: 0 });
  const latest = entries[0];

  useEffect(() => {
    const previous = current.current;
    const incoming = entries.filter(entry => entry.lastEvent > consumed.current.event);
    const candidates = incoming.filter(entry => !announced.current.has(entry.id) || entry.id === previous.notice?.historyId
      || previous.pending.some(item => item.historyId === entry.id));
    incoming.forEach(entry => announced.current.add(entry.id));
    const retained = new Set(entries.map(entry => entry.id));
    announced.current.forEach(id => { if (!retained.has(id)) announced.current.delete(id); });
    const newToasts = messages.filter(message => message.id > consumed.current.toast);
    const throughId = newToasts.at(-1)?.id;
    consumed.current = { event: latest?.lastEvent ?? consumed.current.event, toast: throughId ?? consumed.current.toast };
    const next = candidates.sort((left, right) => left.lastEvent - right.lastEvent).map(fromHistory);
    for (const newToast of newToasts) {
      // Use an explicit record link so unrelated notifications never borrow WKC values.
      const related = entries.find(entry => entry.id === newToast.historyId);
      if (related) {
        if (!next.some(item => item.historyId === related.id) && (related.id === previous.notice?.historyId
          || previous.pending.some(item => item.historyId === related.id))) next.push(fromHistory(related));
      } else {
        const [title, ...rest] = newToast.text.split(/[。；\n]/);
        next.push({ key: `toast:${newToast.id}`, title, detail: rest.filter(Boolean).join("；"), severity: newToast.severity });
      }
    }
    if (throughId !== undefined) onMessagesConsumed?.(throughId);
    if (open || !next.length) return;
    const update = next.find(item => item.key === previous.notice?.key);
    if (update && previous.showing) setNotice(update);
    const additions = next.filter(item => item.key !== previous.notice?.key);
    if (!additions.length) return;
    setPending(queue => {
      const updated = [...queue];
      for (const item of additions) {
        const index = updated.findIndex(queued => queued.key === item.key);
        if (index >= 0) updated[index] = item;
        else updated.push(item);
      }
      // Severity orders waiting messages; it never interrupts the visible message.
      return updated.sort((left, right) => priority[right.severity] - priority[left.severity]);
    });
  }, [entries, latest, messages, onMessagesConsumed, open]);

  useEffect(() => { if (open) { setShowNotice(false); setPending([]); } }, [open]);
  const visibleProgress = progress && dismissedProgress !== progress.key ? progress : undefined;
  const showingProgress = Boolean(visibleProgress && (!showNotice || !notice || priority[visibleProgress.severity] > priority[notice.severity]));
  const expanded = !open && Boolean(showingProgress || showNotice && notice);
  const paused = hovered || focused || showingProgress;
  const frame = useMemo<ContentFrame | undefined>(() => {
    const content = showingProgress && visibleProgress
      ? { ...visibleProgress, key: `progress:${visibleProgress.key}`, progress: visibleProgress } : notice;
    if (!content) return undefined;
    const context = measure.current ??= document.createElement("canvas").getContext("2d")!;
    const textWidth = (text: string, size: number, weight: number) => {
      context.font = `${weight} ${size}px ${theme.typography.fontFamily}`;
      return context.measureText(text).width;
    };
    const actionWidth = showingProgress && visibleProgress?.onAction ? textWidth(visibleProgress.actionLabel ?? "", 11, 650) + 14 : 0;
    // Include the actual font metrics, icon, padding, and both right-side controls.
    const width = Math.ceil(Math.max(textWidth(content.title, 12, 600), textWidth(content.detail, 11, 400)) + 136 + actionWidth);
    return { ...content, width: Math.max(dockSize.minExpanded, Math.min(dockSize.maxExpanded, width)) };
  }, [showingProgress, visibleProgress, notice, theme.typography.fontFamily]);
  const [displayed, setDisplayed] = useState<ContentFrame>();
  const [outgoing, setOutgoing] = useState<ContentFrame>();
  const readClock = useRef({ key: "", notBefore: 0, readyAt: 0 });
  const settled = useDockMorph(dockRef, open ? "history" : expanded ? "notice" : "idle",
    open ? 520 : displayed?.width ?? dockSize.minExpanded,
    open ? 580 : displayed?.progress ? dockSize.progressHeight : dockSize.noticeHeight, onHistorySettled);

  useLayoutEffect(() => {
    if (!expanded) { readClock.current = { key: "", notBefore: 0, readyAt: 0 }; return; }
    if (displayed?.key !== readClock.current.key) return;
    if (!settled) readClock.current.readyAt = 0;
    else if (!readClock.current.readyAt) readClock.current.readyAt = Math.max(performance.now(), readClock.current.notBefore);
  }, [expanded, settled, displayed?.key]);

  useLayoutEffect(() => {
    // Retain the visible frame throughout retraction, including completed progress.
    if (!expanded || !frame) return;
    if (displayed?.key === frame.key) { setDisplayed(frame); return; }
    const replace = () => {
      if (displayed) setOutgoing(displayed);
      readClock.current = { key: frame.key, notBefore: performance.now() + contentFadeTime, readyAt: 0 };
      setDisplayed(frame);
    };
    if (displayed && readClock.current.key === displayed.key) {
      if (!settled || !readClock.current.readyAt) return;
      const remaining = readClock.current.readyAt + minimumVisibleTime - performance.now();
      if (remaining > 0) {
        const timer = window.setTimeout(replace, remaining);
        return () => window.clearTimeout(timer);
      }
    }
    replace();
  }, [expanded, frame, settled]);
  useEffect(() => {
    if (!outgoing) return;
    const timer = window.setTimeout(() => setOutgoing(undefined), contentFadeTime);
    return () => window.clearTimeout(timer);
  }, [outgoing]);

  useEffect(() => {
    if (open || !pending.length) return;
    const advance = () => { setNotice(pending[0]); setShowNotice(true); setPending(queue => queue.slice(1)); };
    if (!showNotice) { advance(); return; }
    if (notice && priority[pending[0].severity] < priority[notice.severity]) return;
    if (paused || !settled || displayed?.key !== notice?.key || !readClock.current.readyAt) return;
    const remaining = Math.max(0, readClock.current.readyAt + minimumVisibleTime - performance.now());
    const timer = window.setTimeout(advance, remaining);
    return () => window.clearTimeout(timer);
  }, [open, pending, showNotice, paused, settled, displayed?.key, notice?.key, notice?.severity]);

  useEffect(() => {
    if (notice && clock.current.key !== notice.key) clock.current = { key: notice.key, remaining: duration[notice.severity] };
    if (!showNotice || open || paused || !settled || displayed?.key !== notice?.key) return;
    const started = Date.now();
    const timer = window.setTimeout(() => { clock.current.remaining = 0; setShowNotice(false); }, clock.current.remaining);
    return () => { window.clearTimeout(timer); clock.current.remaining = Math.max(0, clock.current.remaining - (Date.now() - started)); };
  }, [notice?.key, showNotice, open, paused, settled, displayed?.key]);
  useEffect(() => {
    if (!visibleProgress || visibleProgress.running || open || hovered || focused || !settled || displayed?.key !== `progress:${visibleProgress.key}`) return;
    const timer = window.setTimeout(() => { setDismissedProgress(visibleProgress.key); visibleProgress.onDismiss?.(); }, duration[visibleProgress.severity]);
    return () => window.clearTimeout(timer);
  }, [visibleProgress?.key, visibleProgress?.running, visibleProgress?.severity, open, hovered, focused, settled, displayed?.key]);
  useEffect(() => { setDismissedProgress(undefined); }, [progress?.key]);
  useEffect(() => {
    if (open && progress && !progress.running) setDismissedProgress(progress.key);
  }, [open, progress?.key, progress?.running]);

  const dismiss = () => {
    setPending([]);
    if (displayed?.progress) {
      setDismissedProgress(displayed.progress.key);
      if (displayed.progress.key === visibleProgress?.key) displayed.progress.onDismiss?.();
    }
    else setShowNotice(false);
  };
  const renderFrame = (content: ContentFrame, exiting = false) => {
    const Icon = icon[content.severity];
    const frameColor = colors[content.severity];
    const interactive = expanded && !exiting;
    const showRecord = () => { if (interactive && content.historyId) { setShowNotice(false); onShowRecord(content.historyId); } };
    return <Box key={`${exiting ? "out" : "in"}:${content.key}`} className={`dock-content${exiting ? " dock-outgoing" : ""}`}
      role={interactive ? "status" : undefined} aria-hidden={exiting || !expanded} onClick={showRecord}
      sx={{ position: "absolute", left: 0, top: 0, width: content.width - 2,
        height: content.progress ? dockSize.progressHeight - 2 : dockSize.noticeHeight - 2,
        display: "flex", alignItems: "center", gap: 1.25, pl: 2, pr: 10, boxSizing: "border-box", pointerEvents: exiting ? "none" : undefined,
        animation: `${exiting ? "dock-message-out" : "dock-message-in"} 220ms ${dockEase} both`,
        "@keyframes dock-message-in": { from: { opacity: 0, transform: "translateY(4px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        "@keyframes dock-message-out": { from: { opacity: 1, transform: "translateY(0)" }, to: { opacity: 0, transform: "translateY(-4px)" } } }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, flexShrink: 0, borderRadius: "50%", bgcolor: `${frameColor}12` }}><Icon sx={{ fontSize: 18, color: frameColor }} /></Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography component={content.historyId ? "button" : "div"} tabIndex={interactive && content.historyId ? 0 : -1}
          title={content.title} sx={{ display: "block", width: "100%", fontFamily: "inherit", fontSize: 12, fontWeight: 600, lineHeight: 1.6,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", border: 0, p: 0, bgcolor: "transparent", color: "text.primary", textAlign: "left",
            cursor: content.historyId ? "pointer" : "default", "&:hover": { color: content.historyId ? "primary.main" : "text.primary" } }}>{content.title}</Typography>
        {content.detail && <Typography fontSize={11} color="text.secondary" title={content.detail} sx={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", lineHeight: 1.6 }}>{content.detail}</Typography>}
        {content.progress && <LinearProgress aria-label="任务进度" variant={content.progress.percent === undefined ? "indeterminate" : "determinate"} value={content.progress.percent} sx={{ mt: 0.5, height: 2, borderRadius: 1, bgcolor: "#EDF0F5", "& .MuiLinearProgress-bar": { bgcolor: frameColor } }} />}
      </Box>
      {content.progress?.onAction && <Button size="small" tabIndex={interactive ? 0 : -1} onClick={content.progress.onAction} sx={{ minWidth: 0, p: 0.25, fontSize: 11, flexShrink: 0 }}>{content.progress.actionLabel}</Button>}
    </Box>;
  };

  return <Paper ref={dockRef} elevation={0} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    sx={{ position: "fixed", bottom: 16, right: 24, width: `var(--dock-width, ${dockSize.collapsed}px)`, height: `var(--dock-height, ${dockSize.height}px)`,
      maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 32px)",
      overflow: "hidden", border: 1, borderColor: "divider", borderRadius: "var(--dock-radius, 18px)",
      bgcolor: "background.paper", boxShadow: open ? "0 12px 48px rgba(23,32,51,.16), 0 2px 8px rgba(23,32,51,.04)" : expanded ? "0 4px 20px rgba(23,32,51,.12)" : "0 2px 10px rgba(23,32,51,.08)", zIndex: theme => theme.zIndex.drawer + 1,
      transition: "box-shadow 320ms ease, border-color 180ms ease",
      "& .dock-dismiss": { opacity: hovered || focused ? 1 : 0 },
      "@media (prefers-reduced-motion: reduce)": { transition: "none", "& .dock-reveal, & .dock-history, & .dock-history > * > *": { transition: "none", transform: "none" }, "& .dock-content": { animation: "none" }, "& .dock-outgoing": { opacity: 0 } } }}>
    {/* Keep the history layout fixed while its shared shell changes shape. */}
    <Box className="dock-history" inert={!open} aria-hidden={!open} sx={{ position: "absolute", right: 0, bottom: 0,
      width: 518, height: 578, maxWidth: "calc(100vw - 50px)", maxHeight: "calc(100vh - 34px)",
      opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none",
      transition: open ? "opacity 180ms ease 140ms" : "opacity 100ms ease",
      "& > * > *": { opacity: open ? 1 : 0, transform: open ? "translateY(0)" : "translateY(4px)",
        transition: open ? `opacity 180ms ease 160ms, transform 240ms ${dockEase} 160ms` : "opacity 80ms ease, transform 100ms ease" },
      "& > * > :nth-of-type(2)": { transitionDelay: open ? "190ms" : "0ms" },
      "& > * > :nth-of-type(3)": { transitionDelay: open ? "220ms" : "0ms" } }}>
      {children}
    </Box>
    <Box className="dock-reveal" inert={!expanded} aria-hidden={!expanded} sx={{ position: "absolute", inset: 0, overflow: "hidden", opacity: expanded ? 1 : 0,
      transform: expanded ? "translateY(0)" : "translateY(5px)",
      transition: expanded ? `opacity 220ms ease 190ms, transform 300ms ${dockEase} 150ms` : "opacity 100ms ease, transform 120ms ease", pointerEvents: expanded ? "auto" : "none" }}>
      {outgoing && renderFrame(outgoing, true)}
      {displayed && renderFrame(displayed)}
      {!displayed?.progress?.running && <IconButton className="dock-dismiss" aria-label="收起提示" tabIndex={expanded ? 0 : -1} onClick={dismiss} sx={{ position: "absolute", top: "50%", transform: "translateY(-50%)", right: 10, width: 24, height: 24, transition: "opacity 120ms" }}><CloseRounded sx={{ fontSize: 13 }} /></IconButton>}
    </Box>
    <Tooltip title={open ? "" : unreadErrors ? "有未读错误" : unread ? "有未读警告" : "查看消息历史"}>
      <Button ref={triggerRef} aria-label="消息历史" aria-expanded={open} aria-controls="message-history-panel" tabIndex={open ? -1 : 0} aria-hidden={open} onClick={onToggle}
        sx={{ position: "absolute", right: expanded ? 42 : 0, bottom: expanded ? displayed?.progress ? 21 : 17 : 0, height: expanded ? 28 : dockSize.height - 2,
          width: expanded ? 28 : dockSize.collapsed - 2, minWidth: 0, minHeight: 0, p: 0, gap: expanded ? 0 : 0.875,
          borderRadius: "18px", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", color: "text.primary", bgcolor: "transparent",
          opacity: open ? 0 : 1, pointerEvents: open ? "none" : "auto",
          transition: `width 260ms ${dockEase}, right 260ms ${dockEase}, height 220ms ease, gap 180ms ease, ${open ? "opacity 80ms ease" : "opacity 160ms ease 200ms"}`,
          "&:hover": { bgcolor: "#F8F9FC" }, "&.Mui-focusVisible": { outlineOffset: -3 },
          "@media (prefers-reduced-motion: reduce)": { transition: "none", "& .dock-label": { transition: "none" } } }}>
        <Box sx={{ position: "relative", display: "flex" }}><NotificationsNoneRounded sx={{ fontSize: 17, color: "text.secondary" }} />
          {!!unread && <Box sx={{ position: "absolute", right: -2, top: -1, width: 5, height: 5, borderRadius: "50%", bgcolor: unreadErrors ? "error.main" : "warning.main", border: "1px solid white" }} />}
        </Box><Box component="span" className="dock-label" sx={{ overflow: "hidden", maxWidth: expanded ? 0 : 48, opacity: expanded ? 0 : 1, flexShrink: 0, lineHeight: 1,
          transition: expanded ? "opacity 80ms ease, max-width 180ms ease" : "opacity 160ms ease 200ms, max-width 200ms ease 120ms" }}>消息历史</Box>
      </Button>
    </Tooltip>
  </Paper>;
}
