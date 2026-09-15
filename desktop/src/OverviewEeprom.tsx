import { useState } from "react";
import { Alert, Box, Button, Card, CardContent, Collapse, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { ExpandMoreRounded, ExpandLessRounded } from "@mui/icons-material";
import { decodeEepromPrefix, decodeEepromStatus } from "./eepromDiagnostics";
import type { SlaveInfo } from "./types";

export function OverviewEeprom({ slave }: { slave: SlaveInfo }) {
  const [expanded, setExpanded] = useState(false);
  const status = decodeEepromStatus(slave.eeprom_status);
  const prefix = decodeEepromPrefix(slave.eeprom_prefix);
  return <>
    <Box className="overview-eeprom-grid">
      <Card variant="outlined"><CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.5 }}><Typography variant="h6">EEPROM 控制 / 状态</Typography><Typography variant="caption" className="mono" color="text.secondary">0x0502–0x0503</Typography></Stack>
        {!status ? <Alert severity={slave.eeprom_status_error ? "warning" : "info"}>{slave.eeprom_status_error || "无可用寄存器数据"}</Alert> : <>
          <Box className="overview-raw"><Typography variant="caption" color="text.secondary">Raw value</Typography><Typography className="mono" fontWeight={700} color="primary.main">{status.raw}</Typography></Box>
          {status.summary.map((field) => <Box className="overview-status-field" key={field.bits}><Typography variant="body2">{field.name}</Typography><Typography variant="body2" fontWeight={650} color={field.error ? "warning.main" : "text.primary"}>{field.description}</Typography></Box>)}
          <Button size="small" aria-expanded={expanded} aria-controls="eeprom-status-details" onClick={() => setExpanded((value) => !value)} endIcon={expanded ? <ExpandLessRounded /> : <ExpandMoreRounded />} sx={{ mt: 1, px: 0 }}>{expanded ? "收起完整位域" : "展开完整位域"}</Button>
        </>}
      </CardContent></Card>
      <Card variant="outlined"><CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}><Typography variant="h6">EEPROM 配置区</Typography><Typography variant="caption" color="text.secondary">前 16 字节</Typography></Stack>
        {!prefix ? <Alert severity={slave.eeprom_prefix_error ? "warning" : "info"}>{slave.eeprom_prefix_error || "无可用 EEPROM 数据"}</Alert> : <>
          <Box className="overview-raw mono overview-prefix-raw">0000: {prefix.raw}</Box>
          <TableContainer><Table size="small" className="overview-data-table"><TableHead><TableRow>{["Word", "原始字节", "16-bit 值", "含义"].map((name) => <TableCell key={name}>{name}</TableCell>)}</TableRow></TableHead><TableBody>
            {prefix.words.map((word) => <TableRow key={word.address} sx={{ opacity: word.name === "Reserved" ? 0.55 : 1 }}><TableCell className="mono">{word.address}</TableCell><TableCell className="mono" sx={{ whiteSpace: "nowrap" }}>{word.bytes}</TableCell><TableCell className="mono" sx={{ fontWeight: 650 }}>{word.value}</TableCell><TableCell>{word.name}</TableCell></TableRow>)}
          </TableBody></Table></TableContainer>
        </>}
      </CardContent></Card>
    </Box>
    <Collapse in={expanded && Boolean(status)} id="eeprom-status-details">
      {status && <Card variant="outlined"><CardContent><Typography variant="h6" sx={{ mb: 1.5 }}>EEPROM 控制 / 状态 · 完整位域</Typography>
        <Box className="overview-raw mono">Raw value: {status.raw}　 Binary: {status.binary}</Box>
        <TableContainer><Table size="small" className="overview-data-table"><TableHead><TableRow>{["Bit", "Name", "Value", "Description"].map((name) => <TableCell key={name}>{name}</TableCell>)}</TableRow></TableHead><TableBody>
          {status.fields.map((field) => <TableRow key={field.bits} sx={{ bgcolor: field.error ? "#fff8ed" : undefined }}><TableCell className="mono">{field.bits}</TableCell><TableCell>{field.name}</TableCell><TableCell className="mono">{field.value}</TableCell><TableCell>{field.description}</TableCell></TableRow>)}
        </TableBody></Table></TableContainer>
      </CardContent></Card>}
    </Collapse>
  </>;
}
