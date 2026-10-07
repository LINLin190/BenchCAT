import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { ChevronRightRounded, ExpandMoreRounded } from "@mui/icons-material";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ManualTarget } from "./PdfManualViewer";

export type ManualOutline = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>;
export type ManualDestination = string | unknown[];
interface Bookmark { key: string; title: string; sectionTitle: string; destination: ManualDestination | null; children: Bookmark[] }
interface Props {
  outline: ManualOutline | null; target: ManualTarget; disabled: boolean; loading: boolean; error: string;
  onNavigate: (destination: ManualDestination) => void;
}

/** Normalize vendor bookmarks once per document rather than on every page or search update. */
function bookmarks(items: ManualOutline, parent = ""): Bookmark[] {
  return items.map((item, index) => {
    const key = `${parent}/${index}`, title = item.title.replaceAll("\0", "").trim();
    return { key, title, sectionTitle: title.replace(/^表\s*(\d+-\d+)\s*[:：]?\s*/, "Table $1 "),
      destination: item.dest, children: bookmarks(item.items, key) };
  });
}

/** Match complete section numbers, including independently named Chinese table bookmarks. */
function sectionPath(items: Bookmark[], section: string): string[] | undefined {
  for (const item of items) {
    if (item.sectionTitle === section || (item.sectionTitle.startsWith(section) && /^\s/.test(item.sectionTitle.slice(section.length)))) return [item.key];
    const child = sectionPath(item.children, section);
    if (child) return [item.key, ...child];
  }
}

/** Keep directory state isolated from the viewer toolbar and create only expanded branches. */
export const PdfManualOutline = memo(function PdfManualOutline({ outline, target, disabled, loading, error, onNavigate }: Props) {
  const nodes = useMemo(() => bookmarks(outline ?? []), [outline]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const activeBookmark = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const path = target.manual.section ? sectionPath(nodes, target.manual.section) : undefined;
    setExpanded(new Set(path?.slice(0, -1)));
    setSelected(path?.at(-1) ?? "");
  }, [nodes, target]);
  useLayoutEffect(() => { activeBookmark.current?.scrollIntoView({ block: "nearest" }); }, [expanded, selected]);

  /** Collapsed descendants are not traversed or built as React elements. */
  const render = (items: Bookmark[], level = 0): ReactNode => items.map((item) => <Box key={item.key}>
    <Stack direction="row" alignItems="flex-start" sx={{ pl: level * 1.5, bgcolor: selected === item.key ? "action.selected" : undefined }}>
      {item.children.length ? <IconButton size="small" aria-label={`${expanded.has(item.key) ? "收起" : "展开"}章节 ${item.title}`} aria-expanded={expanded.has(item.key)}
        onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(item.key)) next.delete(item.key); else next.add(item.key); return next; })}>
        {expanded.has(item.key) ? <ExpandMoreRounded sx={{ fontSize: 18 }} /> : <ChevronRightRounded sx={{ fontSize: 18 }} />}
      </IconButton> : <Box sx={{ width: 28, flexShrink: 0 }} />}
      <Button ref={selected === item.key ? activeBookmark : undefined} disabled={!item.destination || disabled} aria-current={selected === item.key ? "location" : undefined}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", textAlign: "left", px: 0.5, py: 0.65, fontSize: 12, lineHeight: 1.45, color: "text.primary", textTransform: "none", overflowWrap: "anywhere" }}
        onClick={() => { if (item.destination) { setSelected(item.key); onNavigate(item.destination); } }}>{item.title}</Button>
    </Stack>
    {item.children.length > 0 && expanded.has(item.key) && render(item.children, level + 1)}
  </Box>);

  return <Box component="nav" aria-label="手册目录" sx={{ width: 280, flexShrink: 0, overflowY: "auto", bgcolor: "background.paper", borderRight: 1, borderColor: "divider", px: 1, py: 1.25 }}>
    <Typography fontSize={13} fontWeight={700} sx={{ px: 1, pb: 1 }}>目录</Typography>
    {error ? <Alert severity="info">{error}</Alert> : nodes.length ? render(nodes) : <Typography fontSize={12} color="text.secondary" sx={{ px: 1 }}>{loading ? "正在加载目录…" : "此手册未提供目录，请使用页码或搜索。"}</Typography>}
  </Box>;
});
