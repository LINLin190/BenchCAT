import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { ArrowUpwardRounded, CloseRounded, ContentCopyRounded, DeleteOutlineRounded, ErrorOutlineRounded, ExpandMoreRounded, NotificationsNoneRounded, WarningAmberRounded } from "@mui/icons-material";
import { copyMessage, messageHistory, messageTime, type HistoryMessage } from "./messageHistory";
import { MessageDock, type DockMessage, type DockProgress } from "./MessageDock";

export const MessageHistoryPanel = memo(function MessageHistoryPanel({ messages, onMessagesConsumed, progress }: { messages: readonly DockMessage[]; onMessagesConsumed?: (throughId: number) => void; progress?: DockProgress }) {
  const { entries, unread, unreadErrors } = useSyncExternalStore(messageHistory.subscribe, messageHistory.snapshot);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("all");
  const [copyResult, setCopyResult] = useState<{ id: number; text: string; error: boolean }>();
  const [highlighted, setHighlighted] = useState<number>();
  const [visible, setVisible] = useState(100);
  const [atLatest, setAtLatest] = useState(true);
  const [seenEvent, setSeenEvent] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingRecord = useRef<number | undefined>(undefined);
  const restoreFocus = useRef(false);
  const scroll = useRef<{ top: number; height: number; latest: boolean; anchor?: { id: string; offset: number } }>({ top: 0, height: 0, latest: true });
  const newestEvent = entries[0]?.lastEvent ?? 0;
  const counts = { all: entries.length, error: entries.filter(entry => entry.result === "error").length, warning: entries.filter(entry => entry.result === "warning").length };
  const filtered = useMemo(() => entries.filter(entry => result === "all" || entry.result === result), [entries, result]);

  const captureScroll = (element: HTMLDivElement) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.getBoundingClientRect().bottom > top);
    scroll.current = { top: element.scrollTop, height: element.scrollHeight, latest: element.scrollTop <= 12,
      anchor: row ? { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top } : undefined };
  };

  useEffect(() => { messageHistory.setViewing(open && atLatest); return () => messageHistory.setViewing(false); }, [open, atLatest]);
  useEffect(() => {
    if (!open) return;
    const clickAway = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || dock.current?.contains(target)) return;
      // Keep the outside click available to the control the user actually selected.
      restoreFocus.current = false; setOpen(false); setCopyResult(undefined);
    };
    document.addEventListener("pointerdown", clickAway, true);
    return () => document.removeEventListener("pointerdown", clickAway, true);
  }, [open]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [highlighted]);
  useEffect(() => {
    if (!copyResult) return;
    const timer = window.setTimeout(() => setCopyResult(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [copyResult]);
  useLayoutEffect(() => {
    scroll.current = { top: 0, height: 0, latest: true };
    if (viewport.current) viewport.current.scrollTop = 0;
    setAtLatest(true); setVisible(100); setSeenEvent(messageHistory.snapshot().entries[0]?.lastEvent ?? 0);
  }, [open, result]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // Anchor to a visible row even when the oldest retained row is removed.
    const anchor = scroll.current.anchor;
    const row = anchor ? element.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`) : null;
    element.scrollTop = scroll.current.latest ? 0 : row && anchor
      ? element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
      : scroll.current.top + element.scrollHeight - scroll.current.height;
    const latest = scroll.current.latest;
    captureScroll(element);
    if (latest) setSeenEvent(newestEvent);
  }, [entries, filtered, open, newestEvent, visible]);
  useLayoutEffect(() => {
    const id = pendingRecord.current, element = viewport.current;
    if (!open || id === undefined || !element) return;
    const index = filtered.findIndex(entry => entry.id === id);
    if (index < 0) { pendingRecord.current = undefined; return; }
    if (index >= visible) { setVisible(Math.ceil((index + 1) / 100) * 100); return; }
    const row = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!row) return;
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 3;
    captureScroll(element); setAtLatest(element.scrollTop <= 12); setHighlighted(id); pendingRecord.current = undefined;
  }, [open, filtered, visible]);

  const close = () => { restoreFocus.current = true; setOpen(false); setCopyResult(undefined); };
  const historySettled = (isOpen: boolean) => {
    if (isOpen && !panel.current?.contains(document.activeElement)) panel.current?.focus();
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); }
  };
  const showRecord = (id: number) => { pendingRecord.current = id; setResult("all"); setOpen(true); };
  const showLatest = () => {
    if (viewport.current) viewport.current.scrollTop = 0;
    scroll.current.latest = true; scroll.current.top = 0;
    setAtLatest(true); setSeenEvent(newestEvent);
  };
  const copy = async (id: number, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopyResult({ id, text: "已复制", error: false }); }
    catch { setCopyResult({ id, text: "复制失败，可手动选取文字", error: true }); }
  };


  const summary = (entry: HistoryMessage) => {
    const text = [entry.operation, entry.context, entry.reason].filter(Boolean).join(" · ");
    return <Stack direction="row" alignItems="center" spacing={1} sx={{ flex: 1, minWidth: 0 }}>
      <Tooltip title={text}><Typography fontSize={11} color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>{text}</Typography></Tooltip>
      {entry.wkc?.map((value, index) => <Tooltip key={index} title={`实际 ${value.actual} / 期望 ${value.expected}`}><Typography className="mono" fontSize={11} color={value.actual !== value.expected ? "error.main" : "text.secondary"} sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>{value.label} {value.actual} / {value.expected}</Typography></Tooltip>)}
      {entry.repeatCount > 1 && <Tooltip title={`首次发生：${messageTime(entry.firstTime, Date.now(), true)}`}><Typography fontSize={10} color="text.secondary" sx={{ flexShrink: 0, px: 0.5, bgcolor: "#F4F6FA", borderRadius: 1 }}>重复 ×{entry.repeatCount}</Typography></Tooltip>}
    </Stack>;
  };

  return <>
    <MessageDock entries={entries} unread={unread} unreadErrors={unreadErrors} messages={messages} onMessagesConsumed={onMessagesConsumed} progress={progress} open={open} triggerRef={trigger} dockRef={dock} onToggle={() => open ? close() : setOpen(true)} onShowRecord={showRecord} onHistorySettled={historySettled}>
    <Box id="message-history-panel" ref={panel} role="region" aria-labelledby="message-history-title" tabIndex={open ? -1 : undefined} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
    }} sx={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", outline: "none" }}>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "#EDF0F5", flexShrink: 0 }}>
        <Typography id="message-history-title" fontSize={13} fontWeight={700} sx={{ flex: 1, whiteSpace: "nowrap", mr: 0.5 }}>消息历史</Typography>
        <Stack direction="row" spacing={0.25} role="group" aria-label="消息类型" sx={{ height: 32, p: 0.25, boxSizing: "border-box", borderRadius: 1, bgcolor: "#F4F6FA", flexShrink: 0 }}>
          {([['all', '全部'], ['error', '错误'], ['warning', '警告']] as const).map(([key, label]) => <Button key={key} aria-pressed={result === key} onClick={() => setResult(key)} sx={{ minWidth: 64, height: 28, minHeight: 28, px: 1, py: 0, borderRadius: 0.75, fontSize: 11.5, lineHeight: "18px", fontWeight: result === key ? 650 : 500, color: result === key ? "text.primary" : "text.secondary", bgcolor: result === key ? "background.paper" : "transparent", boxShadow: result === key ? "0 1px 4px rgba(23,32,51,.08)" : "none", "&:hover": { bgcolor: result === key ? "background.paper" : "#EBEEF5" } }}>{label}<Box component="span" sx={{ ml: 0.625, minWidth: 12, fontSize: 10.5, fontVariantNumeric: "tabular-nums", color: key === "error" && counts[key] ? "error.main" : key === "warning" && counts[key] ? "warning.main" : "text.secondary" }}>{counts[key]}</Box></Button>)}
        </Stack>
        <Button aria-label="清空消息历史" disabled={!entries.length} onClick={() => { messageHistory.clear(); setCopyResult(undefined); showLatest(); }} startIcon={<DeleteOutlineRounded sx={{ fontSize: "14px !important" }} />} sx={{ height: 32, minHeight: 32, minWidth: 60, px: 1, py: 0, flexShrink: 0, fontSize: 11.5, lineHeight: "18px", borderRadius: 1, color: "text.secondary", bgcolor: "#F4F6FA", "& .MuiButton-startIcon": { mr: 0.5, ml: 0 }, "&:hover": { color: "error.main", bgcolor: "#FBEDEF" } }}>清空</Button>
        <Tooltip title="关闭"><IconButton aria-label="关闭消息历史" onClick={close} sx={{ width: 26, height: 26, flexShrink: 0 }}><CloseRounded sx={{ fontSize: 15 }} /></IconButton></Tooltip>
      </Stack>
      <Box sx={{ position: "relative", flex: 1, minHeight: 0 }}>
        {!atLatest && newestEvent > seenEvent && <Button size="small" variant="contained" startIcon={<ArrowUpwardRounded sx={{ fontSize: "13px !important" }} />} onClick={showLatest} sx={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", height: 26, fontSize: 11, borderRadius: 5, boxShadow: 2, zIndex: 1 }}>有新消息</Button>}
        <Box ref={viewport} onScroll={event => {
          const element = event.currentTarget, latest = element.scrollTop <= 12;
          captureScroll(element);
          setAtLatest(latest);
          if (latest) setSeenEvent(newestEvent);
        }} sx={{ height: "100%", overflowY: "auto", overflowAnchor: "none", px: 2 }}>
          {!filtered.length && <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ height: "100%", minHeight: 140, color: "text.secondary" }}>
            <NotificationsNoneRounded sx={{ fontSize: 28, color: "#AAB3C4" }} />
            <Typography fontSize={12}>{entries.length ? "没有匹配的记录" : "暂无错误或警告"}</Typography>
            <Typography fontSize={11}>{entries.length ? "可切换消息类型查看" : "运行中出现的错误与警告会显示在这里"}</Typography>
          </Stack>}
          {filtered.slice(0, visible).map(entry => <Box key={entry.id} data-message-id={entry.id} sx={{ py: 1.5, borderBottom: 1, borderColor: "#EDF0F5", bgcolor: highlighted === entry.id ? "#F1F5FC" : "transparent", transition: "background-color 180ms", userSelect: "text", "& .message-copy": { opacity: 0, pointerEvents: "none" }, "&:hover .message-copy, &:focus-within .message-copy": { opacity: 1, pointerEvents: "auto" } }}>
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <Tooltip title={entry.result === "error" ? "错误" : "警告"}>{entry.result === "error" ? <ErrorOutlineRounded aria-label="错误" sx={{ color: "error.main", fontSize: 15, mt: 0.25 }} /> : <WarningAmberRounded aria-label="警告" sx={{ color: "warning.main", fontSize: 15, mt: 0.25 }} />}</Tooltip>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography fontSize={12} fontWeight={650} sx={{ flex: 1, overflowWrap: "anywhere", lineHeight: 1.6 }}>{entry.text}</Typography>
                  <Tooltip title="复制此条消息"><IconButton className="message-copy" aria-label="复制此条消息" onClick={() => void copy(entry.id, copyMessage(entry))} sx={{ width: 20, height: 20, flexShrink: 0, color: "text.secondary" }}><ContentCopyRounded sx={{ fontSize: 12 }} /></IconButton></Tooltip>
                  <Tooltip title={`${entry.repeatCount > 1 ? '最近发生：' : ''}${messageTime(entry.time, Date.now(), true)}`}><Typography className="mono" fontSize={11} color="text.secondary" sx={{ flexShrink: 0, whiteSpace: "nowrap", lineHeight: 1.6 }}>{messageTime(entry.time, Date.now(), true)}</Typography></Tooltip>
                </Stack>
                <Box sx={{ mt: 0.375 }}>
                  {entry.details?.length ? <Accordion disableGutters elevation={0} sx={{ minWidth: 0, bgcolor: "transparent", "&:before": { display: "none" } }}>
                    <AccordionSummary aria-label="展开消息详情" expandIcon={<ExpandMoreRounded sx={{ fontSize: 13 }} />} sx={{ p: 0, minHeight: "24px !important", "& .MuiAccordionSummary-content, & .MuiAccordionSummary-content.Mui-expanded": { my: 0.25, minWidth: 0, gap: 1, alignItems: "center", mr: 0.375 } }}>
                      {summary(entry)}
                      <Typography fontSize={11} color="text.secondary" sx={{ flexShrink: 0 }}>详情</Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ mt: 0.5, px: 1.25, py: 1, bgcolor: "#F7F8FB", border: "1px solid #EDF0F5", borderRadius: 1, color: "text.secondary" }}>{entry.details.map((detail, index) => <Typography key={index} fontSize={11} sx={{ py: 0.125, fontFamily: "inherit", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>{detail}</Typography>)}</AccordionDetails>
                  </Accordion> : summary(entry)}
                  {copyResult?.id === entry.id && <Typography role="status" fontSize={10} color={copyResult.error ? "error.main" : "text.secondary"} sx={{ display: "block", mt: 0.5 }}>{copyResult.text}</Typography>}
                </Box>
              </Box>
            </Stack>
          </Box>)}
          {filtered.length > visible && <Button fullWidth size="small" sx={{ my: 0.75, height: 28, fontSize: 11 }} onClick={() => setVisible(value => value + 100)}>显示更多记录</Button>}
        </Box>
      </Box>
    </Box>
    </MessageDock>
  </>;
});
