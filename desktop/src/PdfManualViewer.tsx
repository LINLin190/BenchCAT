import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, IconButton, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import { CloseRounded, MenuBookRounded, NavigateBeforeRounded, NavigateNextRounded } from "@mui/icons-material";
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFFindController, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdfManualViewer.css";
import { readRegisterManual } from "./api";
import type { RegisterManualReference } from "./types";
import { PdfManualOutline, type ManualDestination, type ManualOutline } from "./PdfManualOutline";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface ManualTarget {
  manual: RegisterManualReference;
  name: string;
  address: string;
}
interface Props { target: ManualTarget; open: boolean; onClose: () => void }
interface ViewerSession {
  viewer: PDFViewer; links: PDFLinkService; events: EventBus;
  task?: PDFDocumentLoadingTask; documentKey?: string; ready: boolean;
  document?: PDFDocumentProxy;
  retirement?: Promise<void>;
}

/** Dispose obsolete workers once and serialize replacement behind their cleanup. */
function releaseDocument(active: ViewerSession) {
  const task = active.task;
  active.task = undefined; active.document = undefined; active.documentKey = undefined;
  if (task) active.retirement = task.destroy().catch((error) => console.error("Unable to release PDF worker", error));
}

/** Keep one document alive between visits and navigate only after PDF.js initializes its pages. */
const PdfManualViewer = memo(function PdfManualViewer({ target, open, onClose }: Props) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<HTMLDivElement | null>(null);
  const session = useRef<ViewerSession | null>(null);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const visible = useRef(open);
  visible.current = open;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState("1");
  const [count, setCount] = useState(0);
  const [zoom, setZoom] = useState("page-width");
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [outline, setOutline] = useState<ManualOutline | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineError, setOutlineError] = useState("");
  const [outlineLoading, setOutlineLoading] = useState(true);

  const matchesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMatches = useRef("");
  const submittedSearch = useRef("");
  // Bookmark callbacks remain stable while toolbar or register values change.
  const navigateBookmark = useCallback((destination: ManualDestination) => {
    void session.current?.links.goToDestination(destination);
  }, []);

  /** Physical page numbers deliberately ignore printed PDF page labels. */
  const navigate = (active: ViewerSession, destination: number, fitWidth = false) => {
    if (!active.ready) return;
    if (!Number.isInteger(destination) || destination < 1 || destination > active.viewer.pagesCount) return;
    if (fitWidth) active.viewer.currentScaleValue = "page-width";
    active.viewer.scrollPageIntoView({ pageNumber: destination });
    active.viewer.update();
    setPage(String(destination));
  };

  useEffect(() => {
    if (!container || !pages) return;
    const events = new EventBus();
    const links = new PDFLinkService({ eventBus: events, externalLinkTarget: 2 });
    const findController = new PDFFindController({ eventBus: events, linkService: links });
    // Bound canvas memory while retaining detailed rendering for the visible page area.
    const viewer = new PDFViewer({ container, viewer: pages, eventBus: events,
      linkService: links, findController, maxCanvasPixels: 4_194_304, capCanvasAreaFactor: 100 });
    links.setViewer(viewer);
    const active: ViewerSession = { viewer, links, events, ready: false };
    session.current = active;
    events.on("pagesinit", () => {
      if (!visible.current || !active.document || viewer.pdfDocument !== active.document) return;
      active.ready = true;
      navigate(active, currentTarget.current.manual.pdf_page ?? 1, true);
      setLoading(false);
    });
    events.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => { if (visible.current) setPage(String(pageNumber)); });
    events.on("scalechanging", ({ presetValue, scale }: { presetValue?: string; scale: number }) => {
      if (visible.current) setZoom(presetValue || String(Math.round(scale * 100)));
    });
    events.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      if (!visible.current || !submittedSearch.current) return;
      pendingMatches.current = `${matchesCount.current} / ${matchesCount.total}`;
      // Coalesce per-page counts without rebuilding the toolbar for every search match.
      if (matchesTimer.current === undefined) matchesTimer.current = setTimeout(() => {
        matchesTimer.current = undefined;
        if (visible.current && submittedSearch.current) setMatches(pendingMatches.current);
      }, 150);
    });
    events.on("updatefindcontrolstate", ({ state }: { state: number }) => {
      if (!visible.current || !submittedSearch.current) return;
      if (state === 1 || state === 3) {
        clearTimeout(matchesTimer.current); matchesTimer.current = undefined;
        setMatches(state === 1 ? "未找到" : "搜索中…");
      }
    });
    // Width-dependent zoom must follow the actual dialog container.
    let resizeFrame = 0, lastWidth = 0, lastHeight = 0;
    const resize = new ResizeObserver(() => {
      if (resizeFrame || !visible.current || !active.ready) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const width = container.clientWidth, height = container.clientHeight;
        if (!visible.current || !active.ready || !width || (width === lastWidth && height === lastHeight)) return;
        lastWidth = width; lastHeight = height;
        if (["page-width", "page-fit"].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
        viewer.update();
      });
    });
    resize.observe(container);
    return () => {
      session.current = null;
      resize.disconnect();
      cancelAnimationFrame(resizeFrame);
      clearTimeout(matchesTimer.current); matchesTimer.current = undefined;
      viewer.setDocument(null);
      links.setDocument(null);
      releaseDocument(active);
    };
  }, [container, pages]);

  useEffect(() => {
    const active = session.current;
    if (!active) return;
    submittedSearch.current = "";
    if (!open) {
      // Detaching cancels rendering/search and drops all canvases while keeping one parsed PDF.
      active.ready = false;
      active.viewer.setDocument(null);
      active.links.setDocument(null);
      clearTimeout(matchesTimer.current); matchesTimer.current = undefined;
      return;
    }
    const manual = target.manual;
    const documentKey = `${manual.filename}|${manual.sha256 ?? ""}`;
    setSearch(""); setMatches(""); setOutlineOpen(false);
    active.events.dispatch("findbarclose", { source: active });
    if (active.documentKey === documentKey && active.document) {
      if (manual.pdf_page != null && (!Number.isInteger(manual.pdf_page) || manual.pdf_page < 1 || manual.pdf_page > active.document.numPages)) {
        setError("手册定位页码超出文档范围。");
        return;
      }
      setError("");
      if (active.viewer.pdfDocument === active.document && active.ready) navigate(active, manual.pdf_page ?? 1, true);
      else {
        setLoading(true);
        active.links.setDocument(active.document);
        active.viewer.setDocument(active.document);
      }
      return;
    }
    // Cancel obsolete loads before replacing the worker document.
    let cancelled = false;
    const abort = new AbortController();
    active.ready = false;
    active.documentKey = undefined;
    active.viewer.setDocument(null);
    active.links.setDocument(null);
    setLoading(true); setError(""); setCount(0); setOutline(null); setOutlineError(""); setOutlineLoading(true);
    const previous = active.task;
    if (previous) releaseDocument(active);
    void (async () => {
      try {
        await active.retirement;
        if (cancelled) return;
        const bytes = await readRegisterManual(manual.filename, abort.signal);
        if (cancelled) return;
        if (manual.sha256) {
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
          if (hash !== manual.sha256) throw new Error("手册版本与页码索引不一致，请更新索引或重新安装完整应用。");
        }
        if (cancelled) return;
        const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
        const task = getDocument({ data: new Uint8Array(bytes), password: "", disableAutoFetch: true,
          cMapUrl: `${assetBase}cmaps/`, cMapPacked: true,
          standardFontDataUrl: `${assetBase}standard_fonts/`, wasmUrl: `${assetBase}wasm/`, iccUrl: `${assetBase}iccs/` });
        active.task = task;
        const document = await task.promise;
        if (cancelled) return;
        if (manual.page_count && document.numPages !== manual.page_count) throw new Error("手册页数与索引不一致。");
        if (manual.pdf_page != null && (!Number.isInteger(manual.pdf_page) || manual.pdf_page < 1 || manual.pdf_page > document.numPages)) {
          throw new Error("手册定位页码超出文档范围。");
        }
        active.documentKey = documentKey;
        active.document = document;
        setCount(document.numPages);
        active.links.setDocument(document);
        active.viewer.setDocument(document);
      } catch (failure) {
        if (!cancelled) {
          releaseDocument(active);
          setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); setOutlineLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true; abort.abort();
      clearTimeout(matchesTimer.current); matchesTimer.current = undefined;
      if (!active.document) releaseDocument(active);
    };
  }, [target, open, container, pages]);

  useEffect(() => {
    const active = session.current, document = active?.document;
    if (!open || !outlineOpen || loading || !active || !document || outline !== null || outlineError) return;
    // Request directory metadata only when the user opens the directory panel.
    void document.getOutline().then((items) => {
      if (session.current === active && active.document === document) { setOutline(items ?? []); setOutlineLoading(false); }
    }).catch(() => {
      if (session.current === active && active.document === document) { setOutlineError("无法加载手册目录，请使用页码或搜索。"); setOutlineLoading(false); }
    });
  }, [open, outlineOpen, loading, outline, outlineError]);

  /** Search the text layer using the official find controller. */
  const find = (previous = false) => {
    submittedSearch.current = search.trim();
    setMatches("搜索中…");
    session.current?.events.dispatch("find", { source: session.current, type: "again", query: search,
      caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  };
  const disabled = loading || Boolean(error);
  const numericPage = Number(page);
  const zoomOptions = [...new Set(["50", "75", "100", "125", "150", "200", "300", zoom])].filter((value) => /^\d+$/.test(value)).sort((a, b) => Number(a) - Number(b));


  return <Dialog open={open} onClose={onClose} keepMounted fullWidth maxWidth={false}
    aria-labelledby="manual-viewer-title" slotProps={{ paper: { sx: { width: "calc(100% - 64px)", maxWidth: 1440, height: "calc(100% - 64px)", m: 4 } } }}>
    <Stack spacing={1} sx={{ px: 2, py: 1.5 }} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); searchInput.current?.focus(); }
    }}>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Box sx={{ flex: 1 }}><Typography id="manual-viewer-title" fontWeight={700}>{target.manual.title}</Typography>
          <Typography fontSize={12} color="text.secondary">{target.name} · {target.address}{target.manual.section ? ` · 章节 ${target.manual.section}` : ""}</Typography></Box>
        <IconButton aria-label="关闭手册" onClick={onClose}><CloseRounded /></IconButton>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button startIcon={<MenuBookRounded />} aria-expanded={outlineOpen} onClick={() => setOutlineOpen((value) => !value)}>目录</Button>
        <IconButton aria-label="上一页" disabled={disabled || numericPage <= 1} onClick={() => session.current && navigate(session.current, numericPage - 1)}><NavigateBeforeRounded /></IconButton>
        <TextField label="PDF 页码" size="small" value={page} disabled={disabled} sx={{ width: 96 }}
          inputProps={{ inputMode: "numeric", "aria-label": "PDF 页码" }} onChange={(event) => setPage(event.target.value)}
          onBlur={() => { if (session.current) { navigate(session.current, Number(page)); setPage(String(session.current.viewer.currentPageNumber)); } }}
          onKeyDown={(event) => { if (event.key === "Enter" && session.current) navigate(session.current, Number(page)); }} />
        <Typography fontSize={13}>/ {count || "—"}</Typography>
        <IconButton aria-label="下一页" disabled={disabled || numericPage >= count} onClick={() => session.current && navigate(session.current, numericPage + 1)}><NavigateNextRounded /></IconButton>
        <Select size="small" value={zoom} disabled={disabled} inputProps={{ "aria-label": "缩放" }} sx={{ minWidth: 120 }} onChange={(event) => {
          if (session.current) session.current.viewer.currentScaleValue = /^\d+$/.test(event.target.value) ? String(Number(event.target.value) / 100) : event.target.value;
        }}>
          <MenuItem value="page-width">适合宽度</MenuItem><MenuItem value="page-fit">适合页面</MenuItem>
          {zoomOptions.map((value) => <MenuItem key={value} value={value}>{value}%</MenuItem>)}
        </Select>
        <Box sx={{ flex: 1 }} />
        <TextField size="small" placeholder="搜索名称或地址" inputRef={searchInput} value={search} disabled={disabled} sx={{ width: 260 }}
          inputProps={{ "aria-label": "搜索手册" }} onChange={(event) => {
            submittedSearch.current = ""; clearTimeout(matchesTimer.current); matchesTimer.current = undefined;
            setSearch(event.target.value); setMatches("");
          }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && search.trim()) find(event.shiftKey); }} />
        <Typography fontSize={12} sx={{ minWidth: 70 }}>{matches}</Typography>
        <Button disabled={disabled || !search.trim()} onClick={() => find(true)}>上一个</Button>
        <Button disabled={disabled || !search.trim()} onClick={() => find()}>下一个</Button>
      </Stack>
      {target.manual.pdf_page == null && <Alert severity="info">未提供可靠页码，可搜索 {target.name} 或 {target.address}。</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
    <Box className="benchcat-manual" sx={{ display: "flex", flex: 1, minHeight: 0, bgcolor: "#525659", borderTop: 1, borderColor: "divider" }}
      onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); searchInput.current?.focus(); } }}>
      {outlineOpen && <PdfManualOutline outline={outline} target={target} disabled={disabled} loading={outlineLoading} error={outlineError} onNavigate={navigateBookmark} />}
      <Box sx={{ position: "relative", flex: 1, minWidth: 0 }}>
        <div ref={setContainer} className="benchcat-manual-container" tabIndex={0}><div ref={setPages} className="pdfViewer" /></div>
        {loading && <Stack sx={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", bgcolor: "#525659", color: "white" }} spacing={2}>
          <CircularProgress color="inherit" size={30} /><Typography fontSize={13}>正在加载离线手册…</Typography>
        </Stack>}
      </Box>
    </Box>
  </Dialog>;
});

export default PdfManualViewer;
