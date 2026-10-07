import { useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Chip, Collapse, IconButton, InputAdornment, List, ListItemButton, Popover, Stack, Tab, Tabs, TextField, Tooltip, Typography } from "@mui/material";
import { CloseRounded, DeleteOutlineRounded, ExpandMoreRounded, FolderOpenRounded, RefreshRounded, SearchRounded, StarOutlineRounded, StarRounded } from "@mui/icons-material";
import { BridgeRequestError, bridgeRequest, revealPath } from "./api";
import { addFixedEsiEntry, fixedEsiEntries, isBinFile, loadFixedEsiState, removeFixedEsiEntry, sameEepromSource, saveFixedEsiState, type FixedEsiEntry } from "./eepromConfig";
import { hex } from "./types";

interface LibraryResult { directory: string; entries: FixedEsiEntry[]; errors: { path: string; error: string }[] }
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

// Share the fixed source list with quick programming, while recent files track opened sources.
export function EepromSources({ recent, current, disabled, active, onChoose, onSelect, onRemoveRecent }: {
  recent: string[]; current?: FixedEsiEntry; disabled: boolean; active: boolean;
  onChoose: () => void; onSelect: (path: string, ordinal?: number) => void;
  onRemoveRecent: (path: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [fixed, setFixed] = useState(loadFixedEsiState);
  const [library, setLibrary] = useState<LibraryResult>({ directory: "", entries: [], errors: [] });
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pathExpanded, setPathExpanded] = useState(false);
  useEffect(() => { if (!active || disabled) setAnchor(null); }, [active, disabled]);
  useEffect(() => { setPathExpanded(false); }, [current?.path]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setFixed(loadFixedEsiState());
    void bridgeRequest<LibraryResult>("esi_library_list").then(value => {
      if (!cancelled) { setLibrary(value); setError(""); }
    }).catch(error => {
      if (!cancelled) setError(error instanceof BridgeRequestError ? error.message : "无法读取固定文件列表");
    });
    return () => { cancelled = true; };
  }, [active, revision]);
  const entries = useMemo(() => fixedEsiEntries(fixed, library.entries), [fixed, library]);
  const search = query.trim().toLowerCase();
  const filteredRecent = recent.filter(path => path.toLowerCase().includes(search));
  const filteredFixed = entries.filter(entry => `${entry.path} ${entry.type_name} ${entry.device_name} ${entry.product_code.toString(16)} ${hex(entry.product_code, 8)}`.toLowerCase().includes(search));
  const isFixed = (entry: FixedEsiEntry) => entries.some(item => sameEepromSource(item, entry));

  // Removing a fixed row only hides its shortcut; it does not delete the source file.
  const toggleFixed = (entry: FixedEsiEntry) => {
    const removing = isFixed(entry);
    setFixed(state => saveFixedEsiState(removing ? removeFixedEsiEntry(state, entry, library.entries) : addFixedEsiEntry(state, entry)));
  };
  // An unopened recent file remains a valid shortcut; loading still resolves its Device.
  const recentEntry = (path: string): FixedEsiEntry => current && sameEepromSource(current, { path }) ? current : entries.find(item => sameEepromSource(item, { path })) ?? {
    path, sha256: "", ordinal: -1, vendor_id: 0, vendor_name: "", device_name: "", type_name: "",
    product_code: 0, revision: 0, byte_size: 0, config_data: "",
  };

  // Each row exposes record deletion before its separate favorite action.
  const renderEntry = (entry: FixedEsiEntry, recentRow: boolean) => {
    // Reveal paths when equal filenames belong to separate records.
    const paths = recentRow ? filteredRecent : filteredFixed.map(item => item.path);
    const showPath = paths.some(path => !sameEepromSource({ path }, entry) && fileName(path).toLowerCase() === fileName(entry.path).toLowerCase());
    return <Box key={entry.path.toLowerCase()} sx={{ position: "relative" }}>
    <ListItemButton disabled={disabled} selected={Boolean(current && sameEepromSource(current, entry))} onClick={() => select(entry.path, recentRow ? undefined : entry.ordinal)} title={entry.path} sx={{ pr: 8, flexDirection: "column", alignItems: "stretch" }}>
      <Box minWidth={0}><Typography variant="body2" fontWeight={650} noWrap>{fileName(entry.path)}</Typography><Typography variant="caption" color="text.secondary" noWrap display="block">{isBinFile(entry.path) ? `BIN${entry.byte_size ? ` · ${entry.byte_size} B` : " · 原始数据"}` : entry.type_name || entry.device_name || "XML · Device 配置"}</Typography>{!recentRow && !isBinFile(entry.path) && entry.ordinal >= 0 && <Typography variant="caption" className="mono">Product {hex(entry.product_code, 8)}</Typography>}</Box>
      {showPath && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", width: "100%", fontSize: 11 }}>{entry.path}</Typography>}
    </ListItemButton>
    <Stack direction="row" sx={{ position: "absolute", right: 2, top: 6 }}>
      <Tooltip title="删除记录（不删除文件）"><span><IconButton size="small" disabled={disabled} aria-label={`删除记录 ${fileName(entry.path)}`} onClick={() => recentRow ? onRemoveRecent(entry.path) : setFixed(state => saveFixedEsiState(removeFixedEsiEntry(state, entry, library.entries)))}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip>
      <Tooltip title={isFixed(entry) ? "移出固定列表" : "加入固定列表"}><span><IconButton size="small" disabled={disabled} aria-label={`${isFixed(entry) ? "移出固定列表" : "加入固定列表"} ${fileName(entry.path)}`} onClick={() => toggleFixed(entry)}>{isFixed(entry) ? <StarRounded color="warning" fontSize="small" /> : <StarOutlineRounded fontSize="small" />}</IconButton></span></Tooltip>
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

  return <Box className="eeprom-source-bar">
    <Stack direction="row" alignItems="center" gap={1} sx={{ minHeight: 30 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>目标文件</Typography>
      {current && <Chip size="small" variant="outlined" color="primary" label={isBinFile(current.path) ? "BIN" : "XML"} />}
      <Button size="small" aria-label="选择目标文件" aria-haspopup="dialog" aria-expanded={Boolean(anchor)} endIcon={<ExpandMoreRounded />} disabled={disabled} onClick={event => setAnchor(event.currentTarget)} sx={{ minWidth: 0, maxWidth: "55%", justifyContent: "flex-start" }}><Typography component="span" variant="body2" fontWeight={650} noWrap title={current?.path}>{current ? fileName(current.path) : "选择 XML/BIN"}</Typography></Button>
      {current && <Tooltip title={isFixed(current) ? "移出固定列表" : "加入固定列表"}><span><IconButton size="small" disabled={disabled} aria-label={isFixed(current) ? "移出固定列表" : "加入固定列表"} onClick={() => toggleFixed(current)}>{isFixed(current) ? <StarRounded color="warning" fontSize="small" /> : <StarOutlineRounded fontSize="small" />}</IconButton></span></Tooltip>}
      <Box sx={{ flex: 1 }} />
      {current && <><Typography variant="caption" color="text.secondary">{current.byte_size > 0 ? `${current.byte_size} B` : "请选择 Device"}</Typography><Button size="small" disabled={disabled} onClick={() => setPathExpanded(value => !value)} aria-expanded={pathExpanded}>文件路径</Button></>}
    </Stack>
    <Collapse in={pathExpanded && Boolean(current)}><Stack direction="row" gap={1} alignItems="center" sx={{ borderTop: 1, borderColor: "divider", pt: 0.5, mt: 0.5 }}><Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{current?.path}</Typography><Button size="small" startIcon={<FolderOpenRounded />} disabled={disabled} sx={{ flexShrink: 0 }} onClick={() => void openLocation()}>打开文件位置</Button></Stack></Collapse>
    {error && !anchor && <Alert severity="warning" sx={{ mt: 0.5 }}>{error}</Alert>}
    <Popover open={Boolean(anchor) && active && !disabled} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }} transformOrigin={{ vertical: "top", horizontal: "left" }} slotProps={{ paper: { className: "eeprom-source-panel", role: "dialog", "aria-label": "XML列表" } }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.5, py: 0.75 }}><Typography fontWeight={750}>XML列表</Typography><IconButton size="small" aria-label="关闭XML列表" onClick={() => setAnchor(null)}><CloseRounded fontSize="small" /></IconButton></Stack>
    <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth" aria-label="EEPROM 文件列表"><Tab label={`最近文件 ${recent.length}`} /><Tab label={`固定列表 ${entries.length}`} /></Tabs>
    <Box sx={{ px: 1, pt: 1 }}><TextField fullWidth size="small" placeholder={tab === 0 ? "搜索文件名 / 路径" : "搜索文件 / Device / Product"} value={query} onChange={event => setQuery(event.target.value)} inputProps={{ "aria-label": "搜索 EEPROM 文件" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 17 }} /></InputAdornment> }} /></Box>
    <List dense className="eeprom-source-list">
      {tab === 0 ? filteredRecent.map(path => renderEntry(recentEntry(path), true)) : filteredFixed.map(entry => renderEntry(entry, false))}
      {!(tab === 0 ? filteredRecent.length : filteredFixed.length) && <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>{search ? "没有匹配的文件" : tab === 0 ? "打开 XML/BIN 后显示最近文件" : "固定列表为空，可收藏当前文件"}</Typography>}
    </List>
    {error && <Alert severity="warning" sx={{ m: 1 }}>{error}</Alert>}
    {tab === 1 && library.errors.length > 0 && <Typography variant="caption" color="warning.main" sx={{ px: 1.5 }}>{library.errors.length} 个文件无法加载</Typography>}
    <Stack direction="row" justifyContent="space-between" sx={{ p: 1, borderTop: 1, borderColor: "divider" }}><Button variant="outlined" size="small" startIcon={<FolderOpenRounded />} disabled={disabled} onClick={choose}>选择 XML/BIN</Button><Button size="small" startIcon={<RefreshRounded />} disabled={disabled} onClick={() => setRevision(value => value + 1)}>刷新固定列表</Button></Stack>
    </Popover>
  </Box>;
}
