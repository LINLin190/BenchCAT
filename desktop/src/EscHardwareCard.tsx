import { useState } from "react";
import { Alert, Box, Button, CardContent, Collapse, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { ExpandLessRounded, ExpandMoreRounded } from "@mui/icons-material";
import { decodeEscHardware, hardwareFamily } from "./escHardware";
import type { SlaveInfo } from "./types";

export function EscHardwareCard({ slave, profile }: { slave: SlaveInfo; profile: string }) {
  const [expanded, setExpanded] = useState(false);
  const decoded = slave.esc_hardware ? decodeEscHardware(profile, slave.esc_hardware) : undefined;
  const offsets = decoded?.family === "ET1100" ? [0, 1] : decoded?.family === "LAN9253" ? [4, 5] : [4];
  return <>
    <CardContent className="overview-hardware">
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.5 }}>
        <Typography variant="h6">ESC 硬件信息</Typography><Typography variant="caption" color="text.secondary">{profile}</Typography>
      </Stack>
      {hardwareFamily(profile) !== profile && <Typography variant="caption" color="text.secondary">按 {hardwareFamily(profile)} 兼容定义解析</Typography>}
      {!decoded ? <Alert severity={slave.esc_hardware_error ? "warning" : "info"}>{slave.esc_hardware_error ? `读取失败：${slave.esc_hardware_error}` : "当前扫描无可用数据"}</Alert> : <>
        <Box className="overview-raw mono overview-prefix-raw">0x0E00–0x0E07: {decoded.bytes.join(" ")}</Box>
        <Stack direction="row" gap={2} alignItems="center" sx={{ mt: 1.5 }}>
          <Typography variant="body2">{decoded.family === "ET1100" ? "Power-On / Strap" : "Strap"}</Typography>
          {offsets.map((offset) => <Typography variant="body2" className="mono" fontWeight={700} key={offset}>E0{offset}: 0x{decoded.bytes[offset]}</Typography>)}
        </Stack>
        {decoded.mismatch && <Alert severity="warning" sx={{ mt: 1 }}>芯片标识与所选型号不一致，请核对 ESC 型号；不会自动切换或重配置。</Alert>}
        <Button size="small" aria-expanded={expanded} aria-controls="esc-hardware-details" endIcon={expanded ? <ExpandLessRounded /> : <ExpandMoreRounded />} onClick={() => setExpanded((value) => !value)} sx={{ mt: 1, px: 0 }}>{expanded ? "收起 bit 解析" : "展开 bit 解析"}</Button>
      </>}
    </CardContent>
    <Collapse in={expanded && Boolean(decoded)} id="esc-hardware-details" sx={{ gridColumn: "1 / -1" }}>
      {decoded && <CardContent><TableContainer><Table size="small" className="overview-data-table"><TableHead><TableRow>{["地址 / Bit", "Name", "Value", "Description"].map((label) => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
        {decoded.fields.filter((field) => !field.reserved).map((field) => <TableRow key={`${field.location}-${field.name}`}><TableCell className="mono" sx={{ whiteSpace: "nowrap" }}>{field.location}</TableCell><TableCell>{field.name}</TableCell><TableCell className="mono">{field.value}</TableCell><TableCell>{field.meaning}</TableCell></TableRow>)}
      </TableBody></Table></TableContainer></CardContent>}
    </Collapse>
  </>;
}
