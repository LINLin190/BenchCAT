import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, Collapse, IconButton, InputAdornment, List, ListItemButton, Popover, Stack, Tab, Tabs, TextField, Tooltip, Typography } from "@mui/material";
import { CloseRounded, DeleteOutlineRounded, ExpandMoreRounded, FolderOpenRounded, RefreshRounded, SearchRounded, StarOutlineRounded, StarRounded } from "@mui/icons-material";
import { BridgeRequestError, bridgeRequest, revealPath } from "./api";
import { addFixedEsiEntry, eepromSourceIndex, fixedEsiEntries, isBinFile, loadFixedEsiState, removeFixedEsiEntry, sameEepromSource, saveFixedEsiState, sourcePathKey, type FixedEsiEntry } from "./eepromConfig";
import { hex } from "./types";

interface LibraryResult { directory: string; entries: FixedEsiEntry[]; errors: { path: string; error: string }[] }
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

// Share the fixed source list with quick programming, while recent files track opened sources.
export const EepromSources = memo(function EepromSources({ recent, current, disabled, active, dragOver, onChoose, onSelect, onRemoveRecent }: {
  recent: string[]; current?: FixedEsiEntry; disabled: boolean; active: boolean;
  dragOver: boolean;
  onChoose: () => void; onSelect: (path: string, ordinal?: number) => void;
  onRemoveRecent: (path: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [fixed, setFixed] = useState(loadFixedEsiState);
  const [library, setLibrary] = useState<LibraryResult>({ directory: "", entries: [], errors: [] });
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [visibleCount, setVisibleCount] = useState(50);
  const refreshRequested = useRef(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pathExpanded, setPathExpanded] = useState(false);
  useEffect(() => { if (!active || disabled) setAnchor(null); }, [active, disabled]);
  useEffect(() => { setPathExpanded(false); }, [current?.path]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setFixed(loadFixedEsiState());
    void bridgeRequest<LibraryResult>("esi_library_list", { refresh: refreshRequested.current }).then(value => {
      if (!cancelled) { setLibrary(value); setError(""); }
    }).catch(error => {
      if (!cancelled) setError(error instanceof BridgeRequestError ? error.message : "无法读取固定文件列表");
    });
    refreshRequested.current = false;
    return () => { cancelled = true; };
  }, [active, revision]);
  const entries = useMemo(() => fixedEsiEntries(fixed, library.entries), [fixed, library]);
  const search = useDeferredValue(query).trim().toLowerCase();
  const recentSearch = useMemo(() => recent.map(path => ({ path, text: path.toLowerCase() })), [recent]);
  const fixedSearch = useMemo(() => entries.map(entry => ({ entry, text: `${entry.path} ${entry.type_name} ${entry.device_name} ${entry.product_code.toString(16)} ${hex(entry.product_code, 8)}`.toLowerCase() })), [entries]);
  const filteredRecent = useMemo(() => recentSearch.filter(item => item.text.includes(search)).map(item => item.path), [recentSearch, search]);
  const filteredFixed = useMemo(() => fixedSearch.filter(item => item.text.includes(search)).map(item => item.entry), [fixedSearch, search]);
  const fixedIndex = useMemo(() => eepromSourceIndex(entries), [entries]);
  const recentIndex = useMemo(() => eepromSourceIndex(filteredRecent.map(path => ({ path }))), [filteredRecent]);
  const filteredIndex = useMemo(() => eepromSourceIndex(filteredFixed), [filteredFixed]);
  useEffect(() => { setVisibleCount(50); }, [tab, search, entries]);
  // An unopened recent file remains a valid shortcut; loading still resolves its Device.
  const recentEntry = (path: string): FixedEsiEntry => current && sameEepromSource(current, { path }) ? current : fixedIndex.byPath.get(sourcePathKey({ path })) ?? {
    path, sha256: "", ordinal: -1, vendor_id: 0, vendor_name: "", device_name: "", type_name: "",
    product_code: 0, revision: 0, byte_size: 0, config_data: "",
  };

  // Keep source selection separate from deletion and shared favorite updates.
  const renderEntry = (entry: FixedEsiEntry, recentRow: boolean) => {
    const inFixedList = fixedIndex.byPath.has(sourcePathKey(entry));
    // Reveal paths when equal filenames belong to separate records.
    const showPath = (recentRow ? recentIndex : filteredIndex).duplicateNames.has(fileName(entry.path).toLowerCase());
    return <Box key={entry.path.toLowerCase()} className="eeprom-file-row" sx={{ position: "relative" }}>
    <ListItemButton disableRipple={false} disabled={disabled} selected={Boolean(current && sameEepromSource(current, entry))} onClick={() => select(entry.path, recentRow ? undefined : entry.ordinal)} title={entry.path} sx={{ pr: 8, flexDirection: "column", alignItems: "stretch" }}>
      <Box minWidth={0}><Typography variant="body2" fontWeight={650} noWrap>{fileName(entry.path)}</Typography><Typography variant="caption" color="text.secondary" noWrap display="block">{isBinFile(entry.path) ? `BIN${entry.byte_size ? ` · ${entry.byte_size} B` : " · 原始数据"}` : entry.type_name || entry.device_name || "XML · Device 配置"}</Typography>{!recentRow && !isBinFile(entry.path) && entry.ordinal >= 0 && <Typography variant="caption" className="mono">Product {hex(entry.product_code, 8)}</Typography>}</Box>
      {showPath && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", width: "100%", fontSize: 11 }}>{entry.path}</Typography>}
    </ListItemButton>
    <Stack direction="row" sx={{ position: "absolute", right: 2, top: 6 }}>
      <Tooltip title="删除记录（不删除文件）"><span className="eeprom-hover-action"><IconButton size="small" disabled={disabled} aria-label={`删除记录 ${fileName(entry.path)}`} onClick={() => recentRow ? onRemoveRecent(entry.path) : setFixed(state => saveFixedEsiState(removeFixedEsiEntry(state, entry, library.entries)))}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip>
      <Tooltip title={inFixedList ? "取消收藏（不删除文件）" : "收藏到固定列表"}><span className={inFixedList ? undefined : "eeprom-hover-action"}><IconButton size="small" disabled={disabled} aria-label={`${inFixedList ? "取消收藏" : "收藏到固定列表"} ${fileName(entry.path)}`} onClick={() => setFixed(state => saveFixedEsiState(inFixedList ? removeFixedEsiEntry(state, entry, library.entries) : addFixedEsiEntry(state, entry)))}>{inFixedList ? <StarRounded fontSize="small" color="warning" /> : <StarOutlineRounded fontSize="small" color="action" />}</IconButton></span></Tooltip>
    </Stack>
  </Box>;
  };
  // Location errors remain visible next to the expanded path.
  const openLocation = async () => {
    if (!current) return;
    try { await revealPath(current.path); }
    catch { setError("无法打开文件位置，请检查文件是否存在。"); }
  };

  // Close the file panel before loading a source or opening the native picker.
  const select = (path: string, ordinal?: number) => { setAnchor(null); onSelect(path, ordinal); };
  const choose = () => { setAnchor(null); onChoose(); };

  return <Box className={`eeprom-source-bar${dragOver && !disabled ? " eeprom-source-drag-over" : ""}`}>
    <Stack direction="row" alignItems="center" gap={1} className="eeprom-file-row" sx={{ minHeight: 30 }}>
      <Button size="small" variant="outlined" disableRipple={false} startIcon={<FolderOpenRounded />} disabled={disabled} onClick={choose} sx={{ flexShrink: 0 }}>选择/拖入XML/BIN</Button>
      <Button size="small" disableRipple={false} aria-label="最近 / 固定文件" aria-haspopup="dialog" aria-expanded={Boolean(anchor)} endIcon={<ExpandMoreRounded />} disabled={disabled} onClick={event => setAnchor(event.currentTarget)} sx={{ flexShrink: 0 }}>最近 / 固定</Button>
      {current && <><Chip size="small" variant="outlined" label={isBinFile(current.path) ? "BIN" : "XML"} /><Typography variant="body2" fontWeight={650} noWrap title={current.path} sx={{ minWidth: 0, maxWidth: "40%" }}>{fileName(current.path)}</Typography></>}
      <Box sx={{ flex: 1 }} />
      {dragOver && !disabled && <Typography variant="caption" color="primary.main" aria-live="polite" sx={{ whiteSpace: "nowrap" }}>松开以加载 XML/BIN</Typography>}
      {current && <><Typography variant="caption" color="text.secondary">{current.byte_size > 0 ? `${current.byte_size} B` : "请选择 Device"}</Typography><Button size="small" disabled={disabled} onClick={() => setPathExpanded(value => !value)} aria-expanded={pathExpanded}>文件路径</Button></>}
    </Stack>
    <Collapse in={pathExpanded && Boolean(current)}><Stack direction="row" gap={1} alignItems="center" sx={{ borderTop: 1, borderColor: "divider", pt: 0.5, mt: 0.5 }}><Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{current?.path}</Typography><Button size="small" startIcon={<FolderOpenRounded />} disabled={disabled} sx={{ flexShrink: 0 }} onClick={() => void openLocation()}>打开文件位置</Button></Stack></Collapse>
    {error && !anchor && <Alert severity="warning" sx={{ mt: 0.5 }}>{error}</Alert>}
    <Popover open={Boolean(anchor) && active && !disabled} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }} transformOrigin={{ vertical: "top", horizontal: "left" }} slotProps={{ paper: { className: "eeprom-source-panel", role: "dialog", "aria-label": "文件列表" } }}>
    {/* The list opens directly on its tabs; closing stays beside the tab strip. */}
    <Stack direction="row" alignItems="center" sx={{ pr: 0.5 }}><Tabs value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth" aria-label="EEPROM 文件列表" sx={{ flex: 1, minWidth: 0 }}><Tab disableRipple={false} label={`最近文件 ${recent.length}`} /><Tab disableRipple={false} label={`固定列表 ${entries.length}`} /></Tabs><IconButton size="small" aria-label="关闭文件列表" onClick={() => setAnchor(null)}><CloseRounded fontSize="small" /></IconButton></Stack>
    <Box sx={{ px: 1, pt: 1 }}><TextField fullWidth size="small" placeholder={tab === 0 ? "搜索文件名 / 路径" : "搜索文件 / Device / Product"} value={query} onChange={event => setQuery(event.target.value)} inputProps={{ "aria-label": "搜索 EEPROM 文件" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 17 }} /></InputAdornment> }} /></Box>
    <List dense className="eeprom-source-list">
      {tab === 0 ? filteredRecent.map(path => renderEntry(recentEntry(path), true)) : filteredFixed.slice(0, visibleCount).map(entry => renderEntry(entry, false))}
      {tab === 1 && filteredFixed.length > visibleCount && <Button fullWidth size="small" onClick={() => setVisibleCount(count => count + 50)}>显示更多（{visibleCount} / {filteredFixed.length}）</Button>}
      {!(tab === 0 ? filteredRecent.length : filteredFixed.length) && <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>{search ? "没有匹配的文件" : tab === 0 ? "打开 XML/BIN 后显示最近文件" : "固定列表为空，可在最近文件中点击星标添加收藏"}</Typography>}
    </List>
    {error && <Alert severity="warning" sx={{ m: 1 }}>{error}</Alert>}
    {tab === 1 && library.errors.length > 0 && <Typography variant="caption" color="warning.main" sx={{ px: 1.5 }}>{library.errors.length} 个文件无法加载</Typography>}
    <Stack direction="row" justifyContent="space-between" sx={{ p: 1, borderTop: 1, borderColor: "divider" }}><Button variant="outlined" size="small" disableRipple={false} startIcon={<FolderOpenRounded />} disabled={disabled} onClick={choose}>选择/拖入XML/BIN</Button><Tooltip title="重新读取固定列表目录中的 XML/BIN，更新外部修改的文件信息"><span><Button size="small" startIcon={<RefreshRounded />} disabled={disabled} onClick={() => { refreshRequested.current = true; setRevision(value => value + 1); }}>刷新固定列表</Button></span></Tooltip></Stack>
    </Popover>
  </Box>;
});
