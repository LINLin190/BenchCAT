import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { hex } from "./types";
import { imageBytes } from "./eepromViewModel";

const PAGE_BYTES = 512;

/** Keep large EEPROM images readable without mounting thousands of table rows. */
export const EepromHexView = memo(function EepromHexView({ data, comparisonData }: { data?: string; comparisonData?: string }) {
  const bytes = useMemo(() => imageBytes(data), [data]);
  const comparison = useMemo(() => imageBytes(comparisonData), [comparisonData]);
  const [page, setPage] = useState(0);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [highlight, setHighlight] = useState<number>();
  const tableRef = useRef<HTMLDivElement>(null);
  const lastPage = Math.max(0, Math.ceil(bytes.length / PAGE_BYTES) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_BYTES;
  const end = Math.min(start + PAGE_BYTES, bytes.length);
  const rowOffsets = Array.from({ length: Math.ceil((end - start) / 16) }, (_, index) => start + index * 16);

  useEffect(() => {
    setPage(0); setAddress(""); setAddressError(""); setCopyMessage(""); setHighlight(undefined);
  }, [data]);

  // Bring the addressed byte into view even near the bottom of a page.
  useLayoutEffect(() => {
    if (!tableRef.current) return;
    tableRef.current.scrollTop = 0;
    tableRef.current.querySelector(".eeprom-hex-highlight")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setCopyMessage("");
  }, [currentPage, highlight]);

  /** Addresses are byte offsets; unprefixed input follows the hex column. */
  const jump = () => {
    const input = address.trim();
    const offset = /^(?:0x)?[0-9a-f]+$/i.test(input) ? Number.parseInt(input.replace(/^0x/i, ""), 16) : NaN;
    if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
      setAddressError(`请输入 ${hex(0)}–${hex(Math.max(0, bytes.length - 1))} 内的字节地址`);
      return;
    }
    if (highlight === offset && currentPage === Math.floor(offset / PAGE_BYTES)) {
      tableRef.current?.querySelector(".eeprom-hex-highlight")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    setPage(Math.floor(offset / PAGE_BYTES)); setHighlight(offset); setAddressError("");
  };

  /** Copy only the displayed byte range and report clipboard errors locally. */
  const copyPage = async () => {
    try { await navigator.clipboard.writeText(bytes.slice(start, end).join(" ")); setCopyMessage("已复制当前页"); }
    catch { setCopyMessage("复制失败，可直接选中表格内容复制"); }
  };

  if (!bytes.length) return <Box className="eeprom-hex-empty"><Typography fontWeight={700}>尚未读取 EEPROM 数据</Typography><Typography variant="body2" color="text.secondary">选择上方读取范围，点击“读取”查看原始字节。</Typography></Box>;

  return <Box className="eeprom-hex-view">
    <Stack direction="row" alignItems="center" gap={1} className="eeprom-hex-tools">
      <TextField size="small" label="字节地址（Hex）" value={address} error={Boolean(addressError)} onChange={(event) => { setAddress(event.target.value); setAddressError(""); }} onKeyDown={(event) => { if (event.key === "Enter") jump(); }} inputProps={{ className: "mono" }} sx={{ width: 140 }} />
      <Button size="small" variant="outlined" className="eeprom-hex-jump" onClick={jump}>跳转</Button>
      <Typography variant="caption" color={addressError ? "error" : "text.secondary"} sx={{ flex: 1 }}>{addressError || copyMessage}</Typography>
      <Button size="small" onClick={() => void copyPage()}>复制当前页</Button>
    </Stack>
    <TableContainer ref={tableRef} className="eeprom-hex-table">
      <Table stickyHeader size="small" aria-label="EEPROM 原始字节">
        {/* Fixed byte columns leave the remaining space to readable ASCII text. */}
        <colgroup><col style={{ width: 88 }} />{Array.from({ length: 16 }, (_, index) => <col key={index} style={{ width: 40 }} />)}<col /></colgroup>
        <TableHead><TableRow><TableCell>字节地址</TableCell>{Array.from({ length: 16 }, (_, index) => <TableCell key={index}>{index.toString(16).toUpperCase().padStart(2, "0")}</TableCell>)}<TableCell>ASCII</TableCell></TableRow></TableHead>
        <TableBody>{rowOffsets.map(offset => {
          const row = bytes.slice(offset, Math.min(offset + 16, end));
          const differs = (column: number) => comparison[offset + column] !== undefined && row[column] !== undefined && comparison[offset + column] !== row[column];
          return <TableRow key={offset} hover><TableCell>{hex(offset, 5)}</TableCell>{Array.from({ length: 16 }, (_, column) => <TableCell key={column} title={differs(column) ? `设备值 ${comparison[offset + column]} → 目标值 ${row[column]}` : undefined} className={[offset + column === highlight ? "eeprom-hex-highlight" : "", differs(column) ? "eeprom-hex-different" : ""].join(" ")}>{row[column] ?? ""}</TableCell>)}<TableCell>{row.map((byte) => { const value = Number.parseInt(byte, 16); return value >= 0x20 && value <= 0x7E ? String.fromCharCode(value) : "."; }).join("")}</TableCell></TableRow>;
        })}</TableBody>
      </Table>
    </TableContainer>
    <Stack direction="row" alignItems="center" gap={1} className="eeprom-hex-pagination">
      <Typography variant="caption" className="mono" color="text.secondary" sx={{ flex: 1 }}>{hex(start, 5)}–{hex(end - 1, 5)} · 共 {bytes.length} B</Typography>
      <Button size="small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
      <Typography variant="caption">{currentPage + 1} / {lastPage + 1}</Typography>
      <Button size="small" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</Button>
    </Stack>
  </Box>;
});
