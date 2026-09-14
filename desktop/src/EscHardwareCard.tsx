import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Card, CardContent, Chip, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { ExpandMoreRounded } from "@mui/icons-material";
import { decodeEscHardware, hardwareFamily } from "./escHardware";
import type { SlaveInfo } from "./types";

export function EscHardwareCard({ slave, profile }: { slave: SlaveInfo; profile: string }) {
  const decoded = slave.esc_hardware ? decodeEscHardware(profile, slave.esc_hardware) : undefined;
  return <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent>
    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Box><Typography variant="h6">ESC 硬件信息</Typography><Typography variant="caption" color="text.secondary">0x0E00–0x0E07</Typography></Box>
      <Chip size="small" variant="outlined" label={`${profile} · 只读`} />
    </Stack>
    {hardwareFamily(profile) !== profile && <Typography variant="caption" color="text.secondary">按 {hardwareFamily(profile)} 兼容定义解析</Typography>}
    {!decoded && <Alert severity={slave.esc_hardware_error ? "warning" : "info"} sx={{ mt: 1 }}>{slave.esc_hardware_error ? `读取失败：${slave.esc_hardware_error}` : "当前扫描无可用数据"}</Alert>}
    {decoded && <>
      <Box className="esc-raw-line">
        <Typography variant="caption" color="text.secondary" className="mono">{decoded.family === "ET1100" ? "0x0E00–0x0E01" : "0x0E00–0x0E07"}</Typography>
        <Typography variant="body2" className="mono esc-raw-bytes" fontWeight={700}>{decoded.bytes.join(" ")}</Typography>
      </Box>
      <Stack direction="row" gap={2.5} flexWrap="wrap">{decoded.summary.map((item) => <Box key={item.label}><Typography className="section-label">{item.label}</Typography><Typography variant="body2" fontWeight={650}>{item.value}</Typography></Box>)}</Stack>
      <Typography variant="caption" className="mono" sx={{ display: "block", mt: 0.75 }}>{decoded.family === "ET1100" ? "Power-On Values" : "Product ID"}：{decoded.value}</Typography>
      {decoded.mismatch && <Alert severity="warning" sx={{ mt: 1 }}>芯片标识与所选型号不一致，请核对 ESC 型号；不会自动切换或重配置。</Alert>}
      <Accordion disableGutters elevation={0} sx={{ mt: 0.5, "&:before": { display: "none" } }}>
        <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0, minHeight: 34 }}><Typography variant="body2">字段解析</Typography></AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}><TableContainer><Table size="small"><TableHead><TableRow>{["地址 / 位", "字段", "原始值", "含义"].map((label) => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
          {decoded.fields.map((field) => <TableRow key={`${field.location}-${field.name}`} sx={{ opacity: field.reserved ? 0.5 : 1 }}><TableCell className="mono" sx={{ whiteSpace: "nowrap" }}>{field.location}</TableCell><TableCell>{field.name}</TableCell><TableCell className="mono">{field.value}</TableCell><TableCell>{field.meaning}</TableCell></TableRow>)}
        </TableBody></Table></TableContainer></AccordionDetails>
      </Accordion>
    </>}
  </CardContent></Card>;
}
