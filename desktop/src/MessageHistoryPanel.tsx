import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, IconButton, InputAdornment, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { ArrowUpwardRounded, CloseRounded, ContentCopyRounded, DeleteOutlineRounded, ErrorOutlineRounded, ExpandMoreRounded, NotificationsNoneRounded, SearchRounded, WarningAmberRounded } from "@mui/icons-material";
import { copyMessage, messageHistory, messageTime } from "./messageHistory";
import { MessageDock, type DockMessage, type DockProgress } from "./MessageDock";

export const MessageHistoryPanel = memo(function MessageHistoryPanel({ messages, onMessagesConsumed, progress }: { messages: readonly DockMessage[]; onMessagesConsumed?: (throughId: number) => void; progress?: DockProgress }) {
  const { entries, unread, unreadErrors } = useSyncExternalStore(messageHistory.subscribe, messageHistory.snapshot);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("all");
  const [search, setSearch] = useState("");
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
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter(entry => (result === "all" || entry.result === result)
      && (!query || `${entry.text} ${entry.context ?? ""} ${entry.reason ?? ""} ${(entry.details ?? []).join(" ")} ${entry.operation} ${(entry.wkc ?? []).map(value => `${value.label} ${value.actual} ${value.expected}`).join(" ")}`.toLowerCase().includes(query)));
  }, [entries, result, search]);

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
  }, [open, result, search]);
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
  const showRecord = (id: number) => { pendingRecord.current = id; setResult("all"); setSearch(""); setOpen(true); };
  const showLatest = () => {
    if (viewport.current) viewport.current.scrollTop = 0;
    scroll.current.latest = true; scroll.current.top = 0;
    setAtLatest(true); setSeenEvent(newestEvent);
  };
  const copy = async (id: number, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopyResult({ id, text: "已复制", error: false }); }
    catch { setCopyResult({ id, text: "复制失败，可手动选取文字", error: true }); }
  };

  return <>
    <MessageDock entries={entries} unread={unread} unreadErrors={unreadErrors} messages={messages} onMessagesConsumed={onMessagesConsumed} progress={progress} open={open} triggerRef={trigger} dockRef={dock} onToggle={() => open ? close() : setOpen(true)} onShowRecord={showRecord} onHistorySettled={historySettled}>
    <Box id="message-history-panel" ref={panel} role="region" aria-labelledby="message-history-title" tabIndex={open ? -1 : undefined} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
    }} sx={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", outline: "none" }}>
      <Stack direction="row" alignItems="center" sx={{ px: 1.75, pt: 1.25, pb: 1, flexShrink: 0 }}>
        <Typography id="message-history-title" fontSize={13} fontWeight={700} sx={{ flex: 1 }}>消息历史</Typography>
        <Tooltip title="关闭"><IconButton aria-label="关闭消息历史" onClick={close} sx={{ width: 24, height: 24 }}><CloseRounded sx={{ fontSize: 15 }} /></IconButton></Tooltip>
      </Stack>
      <Box sx={{ px: 1.75, pb: 1.25, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
        <Stack direction="row" spacing={0.25} role="group" aria-label="消息类型" sx={{ mb: 1, p: 0.25, borderRadius: 1.25, bgcolor: "#F4F6FA" }}>
          {([['all', '全部'], ['error', '错误'], ['warning', '警告']] as const).map(([key, label]) => <Button key={key} aria-pressed={result === key} onClick={() => setResult(key)} sx={{ flex: 1, height: 28, py: 0.25, fontSize: 11, fontWeight: result === key ? 650 : 500, color: result === key ? "text.primary" : "text.secondary", bgcolor: result === key ? "background.paper" : "transparent", boxShadow: result === key ? "0 1px 4px rgba(23,32,51,.08)" : "none", "&:hover": { bgcolor: result === key ? "background.paper" : "#EBEEF5" } }}>{label}<Box component="span" sx={{ ml: 0.75, fontSize: 10, fontVariantNumeric: "tabular-nums", color: key === "error" && counts[key] ? "error.main" : key === "warning" && counts[key] ? "warning.main" : "text.secondary" }}>{counts[key]}</Box></Button>)}
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <TextField fullWidth size="small" placeholder="搜索消息、从站或错误码" value={search} onChange={event => setSearch(event.target.value)} slotProps={{ htmlInput: { "aria-label": "搜索消息历史" }, input: { startAdornment: <InputAdornment position="start" sx={{ mr: 0.75 }}><SearchRounded sx={{ fontSize: 15, color: "text.secondary" }} /></InputAdornment>, endAdornment: search ? <InputAdornment position="end" sx={{ ml: 0 }}><IconButton aria-label="清除搜索" onClick={() => setSearch("")} sx={{ width: 20, height: 20 }}><CloseRounded sx={{ fontSize: 13 }} /></IconButton></InputAdornment> : undefined } }} sx={{ "& .MuiInputBase-root": { height: 28, minHeight: 28, fontSize: 11, borderRadius: 1.25, pl: 1, pr: 0.5 }, "& .MuiInputBase-input": { height: 18, lineHeight: "18px", py: 0 }, "& .MuiOutlinedInput-notchedOutline": { borderColor: "divider" } }} />
          <Button aria-label="清空消息历史" disabled={!entries.length} onClick={() => { messageHistory.clear(); setCopyResult(undefined); showLatest(); }} startIcon={<DeleteOutlineRounded sx={{ fontSize: "14px !important" }} />} sx={{ height: 28, minHeight: 28, minWidth: 60, px: 0.75, py: 0, flexShrink: 0, fontSize: 11, lineHeight: "18px", borderRadius: 1.25, color: "text.secondary", border: 1, borderColor: "divider", "& .MuiButton-startIcon": { mr: 0.5, ml: 0 }, "&:hover": { color: "error.main", bgcolor: "#FBEDEF", borderColor: "#F1CDD2" } }}>清空</Button>
        </Stack>
      </Box>
      <Box sx={{ position: "relative", flex: 1, minHeight: 0 }}>
        {!atLatest && newestEvent > seenEvent && <Button size="small" variant="contained" startIcon={<ArrowUpwardRounded sx={{ fontSize: "13px !important" }} />} onClick={showLatest} sx={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", height: 26, fontSize: 11, borderRadius: 5, boxShadow: 2, zIndex: 1 }}>有新消息</Button>}
        <Box ref={viewport} onScroll={event => {
          const element = event.currentTarget, latest = element.scrollTop <= 12;
          captureScroll(element);
          setAtLatest(latest);
          if (latest) setSeenEvent(newestEvent);
        }} sx={{ height: "100%", overflowY: "auto", overflowAnchor: "none", px: 1.75 }}>
          {!filtered.length && <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ height: "100%", minHeight: 140, color: "text.secondary" }}>
            {entries.length ? <SearchRounded sx={{ fontSize: 26, color: "#AAB3C4" }} /> : <NotificationsNoneRounded sx={{ fontSize: 28, color: "#AAB3C4" }} />}
            <Typography fontSize={12}>{entries.length ? "没有匹配的记录" : "暂无错误或警告"}</Typography>
            <Typography fontSize={11}>{entries.length ? "可调整筛选或搜索内容" : "运行中出现的错误与警告会显示在这里"}</Typography>
          </Stack>}
          {filtered.slice(0, visible).map(entry => <Box key={entry.id} data-message-id={entry.id} sx={{ py: 1.125, borderBottom: 1, borderColor: "#EDF0F5", bgcolor: highlighted === entry.id ? "#F1F5FC" : "transparent", transition: "background-color 180ms", userSelect: "text", "& .message-copy": { opacity: 0, pointerEvents: "none" }, "&:hover .message-copy, &:focus-within .message-copy": { opacity: 1, pointerEvents: "auto" } }}>
            <Stack direction="row" spacing={0.875} alignItems="flex-start">
              <Tooltip title={entry.result === "error" ? "错误" : "警告"}>{entry.result === "error" ? <ErrorOutlineRounded aria-label="错误" sx={{ color: "error.main", fontSize: 15, mt: 0.25 }} /> : <WarningAmberRounded aria-label="警告" sx={{ color: "warning.main", fontSize: 15, mt: 0.25 }} />}</Tooltip>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="baseline" spacing={1}>
                  <Typography fontSize={12} fontWeight={600} sx={{ flex: 1, overflowWrap: "anywhere", lineHeight: 1.55 }}>{entry.text}</Typography>
                  <Tooltip title={`${entry.repeatCount > 1 ? '最近发生：' : ''}${messageTime(entry.time, Date.now(), true)}`}><Typography className="mono" fontSize={10} color="text.secondary" sx={{ flexShrink: 0 }}>{messageTime(entry.time)}</Typography></Tooltip>
                </Stack>
                <Box sx={{ mt: 0.5, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "3px 8px" }}>
                  <Typography fontSize={11} color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{[entry.operation, entry.context].filter(Boolean).join(" · ")}</Typography>
                  {entry.wkc?.map((value, index) => <Tooltip key={index} title={`实际 ${value.actual} / 期望 ${value.expected}`}><Typography className="mono" fontSize={11} color={value.actual !== value.expected ? "error.main" : "text.secondary"}>{value.label} {value.actual} / {value.expected}</Typography></Tooltip>)}
                  {entry.repeatCount > 1 && <Tooltip title={`首次发生：${messageTime(entry.firstTime, Date.now(), true)}`}><Typography fontSize={10} color="text.secondary" sx={{ px: 0.5, bgcolor: "#F4F6FA", borderRadius: 1 }}>重复 ×{entry.repeatCount}</Typography></Tooltip>}
                </Box>
                {entry.reason && <Typography fontSize={11} color="text.secondary" sx={{ mt: 0.375, overflowWrap: "anywhere", lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{entry.reason}</Typography>}
                <Stack direction="row" alignItems="flex-start" sx={{ mt: 0.25 }}>
                  {!!entry.details?.length && <Accordion disableGutters elevation={0} sx={{ flex: 1, minWidth: 0, bgcolor: "transparent", "&:before": { display: "none" } }}>
                    <AccordionSummary expandIcon={<ExpandMoreRounded sx={{ fontSize: 14 }} />} sx={{ p: 0, minHeight: "22px !important", justifyContent: "flex-start", "& .MuiAccordionSummary-content, & .MuiAccordionSummary-content.Mui-expanded": { my: 0.25, flexGrow: 0, mr: 0.5 } }}><Typography fontSize={11} color="text.secondary">详情</Typography></AccordionSummary>
                    <AccordionDetails sx={{ mt: 0.25, p: 1, bgcolor: "#F7F8FB", borderRadius: 1 }}>{entry.details.map((detail, index) => <Typography key={index} fontSize={11} sx={{ py: 0.125, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>{detail}</Typography>)}</AccordionDetails>
                  </Accordion>}
                  {copyResult?.id === entry.id && <Typography role="status" fontSize={10} color={copyResult.error ? "error.main" : "text.secondary"} sx={{ ml: "auto", alignSelf: "center" }}>{copyResult.text}</Typography>}
                  <Tooltip title="复制此条消息"><IconButton className="message-copy" aria-label="复制此条消息" onClick={() => void copy(entry.id, copyMessage(entry))} sx={{ ml: copyResult?.id === entry.id ? 0.5 : "auto", width: 24, height: 24 }}><ContentCopyRounded sx={{ fontSize: 12 }} /></IconButton></Tooltip>
                </Stack>
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
