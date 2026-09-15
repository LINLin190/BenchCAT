import { useState } from "react";
import { Alert, Box, Button, Card, CardContent, Collapse, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { ExpandMoreRounded, ExpandLessRounded } from "@mui/icons-material";
import { decodeEepromPrefix, decodeEepromStatus } from "./eepromDiagnostics";
import type { SlaveInfo } from "./types";

export function OverviewEeprom({ slave }: { slave: SlaveInfo }) {
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [configExpanded, setConfigExpanded] = useState(false);
  const status = decodeEepromStatus(slave.eeprom_status);
  const prefix = decodeEepromPrefix(slave.eeprom_prefix);
  return <>
    <Box className="overview-eeprom-grid">
      <Card variant="outlined"><CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.5 }}><Typography variant="h6">EEPROM 控制 / 状态</Typography><Typography variant="caption" className="mono" color="text.secondary">0x0502–0x0503</Typography></Stack>
        {!status ? <Alert severity={slave.eeprom_status_error ? "warning" : "info"}>{slave.eeprom_status_error || "无可用寄存器数据"}</Alert> : <>
          <Box className="overview-raw"><Typography variant="caption" color="text.secondary">Raw value</Typography><Typography className="mono" fontWeight={700} color="primary.main">{status.raw}</Typography></Box>
          {status.summary.map((field) => <Box className="overview-status-field" key={field.bits}><Typography variant="body2">{field.name}</Typography><Typography variant="body2" fontWeight={650} color={field.error ? "warning.main" : "text.primary"}>{field.description}{field.detail ? `（${field.detail}）` : ""}</Typography></Box>)}
          <Button size="small" aria-expanded={statusExpanded} aria-controls="eeprom-status-details" onClick={() => setStatusExpanded((value) => !value)} endIcon={statusExpanded ? <ExpandLessRounded /> : <ExpandMoreRounded />} sx={{ mt: 1, px: 0 }}>{statusExpanded ? "收起完整位域" : "展开完整位域"}</Button>
        </>}
      </CardContent></Card>
      <Card variant="outlined"><CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}><Typography variant="h6">EEPROM 配置区</Typography><Typography variant="caption" color="text.secondary">前 16 字节</Typography></Stack>
        {!prefix ? <Alert severity={slave.eeprom_prefix_error ? "warning" : "info"}>{slave.eeprom_prefix_error || "无可用 EEPROM 数据"}</Alert> : <>
          <Box className="overview-raw mono overview-prefix-raw">0000: {prefix.raw}</Box>
          <Box className="overview-config-summary"><Box><Typography variant="caption">0x0140 · PDI Control</Typography><Typography fontWeight={700}>{prefix.pdiType} · {prefix.pdiControl}</Typography></Box><Box><Typography variant="caption">0x0150 · PDI Configuration</Typography><Typography className="mono" fontWeight={700}>{prefix.pdiConfiguration}</Typography></Box></Box>
          <Button size="small" aria-expanded={configExpanded} aria-controls="eeprom-config-details" onClick={() => setConfigExpanded((value) => !value)} endIcon={configExpanded ? <ExpandLessRounded /> : <ExpandMoreRounded />} sx={{ mt: 1, px: 0 }}>{configExpanded ? "收起配置解析" : "展开配置解析"}</Button>
        </>}
      </CardContent></Card>
    </Box>
    <Collapse in={statusExpanded && Boolean(status)} id="eeprom-status-details">
      {status && <Card variant="outlined"><CardContent><Typography variant="h6" sx={{ mb: 1.5 }}>EEPROM 控制 / 状态 · 完整位域</Typography>
        <Box className="overview-raw mono">Raw value: {status.raw}　 Binary: {status.binary}</Box>
        <TableContainer><Table size="small" className="overview-data-table"><TableHead><TableRow>{["Bit", "Name", "Value", "Description"].map((name) => <TableCell key={name}>{name}</TableCell>)}</TableRow></TableHead><TableBody>
          {status.fields.map((field) => <TableRow key={field.bits} sx={{ bgcolor: field.error ? "#fff8ed" : undefined }}><TableCell className="mono">{field.bits}</TableCell><TableCell>{field.name}</TableCell><TableCell className="mono">{field.value}</TableCell><TableCell>{field.description}</TableCell></TableRow>)}
        </TableBody></Table></TableContainer>
      </CardContent></Card>}
    </Collapse>
    <Collapse in={configExpanded && Boolean(prefix)} id="eeprom-config-details">
      {prefix && <Card variant="outlined"><CardContent><Typography variant="h6" sx={{ mb: 1.5 }}>EEPROM 配置解析</Typography><TableContainer><Table size="small" className="overview-data-table"><TableHead><TableRow>{["Word", "原始字节", "16-bit 值", "含义"].map((name) => <TableCell key={name}>{name}</TableCell>)}</TableRow></TableHead><TableBody>{prefix.words.filter((word) => word.name !== "Reserved").map((word) => <TableRow key={word.address}><TableCell className="mono">{word.address}</TableCell><TableCell className="mono">{word.bytes}</TableCell><TableCell className="mono" sx={{ fontWeight: 650 }}>{word.value}</TableCell><TableCell>{word.name}</TableCell></TableRow>)}</TableBody></Table></TableContainer><Box className="overview-config-detail-grid"><Typography><span className="mono">0x0140</span> · PDI Control：{prefix.pdiType} · 原始值 {prefix.pdiControl}</Typography><Typography><span className="mono">0x0141</span> · ESC Configuration：原始值 {prefix.escConfiguration}</Typography><Typography><span className="mono">0x0150</span> · PDI Configuration：原始值 {prefix.pdiConfiguration}</Typography><Typography><span className="mono">0x0151</span> · SYNC/LATCH Configuration：原始值 {prefix.syncLatchConfiguration}</Typography></Box></CardContent></Card>}
    </Collapse>
  </>;
}
