import type { ReactNode } from "react";
import { Alert, Box, Card, CardContent, Collapse, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { CardHeading, useDisclosure } from "./OverviewDisclosure";
import { decodeEscHardware, hardwareFamily } from "./escHardware";
import type { SlaveInfo } from "./types";

/** ESC hardware identification from the scanned 0x0E00–0x0E07 snapshot. Renders its own card
 *  so it can be dropped into the overview grid as one grid item. */
export function EscHardwareCard({ slave, profile, modelControl, modelNote, identity }: { slave: SlaveInfo; profile: string; modelControl?: ReactNode; modelNote?: ReactNode; identity?: ReactNode }) {
  const disclosure = useDisclosure("详情", "esc-hardware-details");
  const decoded = slave.esc_hardware ? decodeEscHardware(profile, slave.esc_hardware) : undefined;
  const eepromSize = decoded?.fields.find((field) => field.name === "EEPROM_SIZE_STRAP" || field.name === "E2PSIZE");
  return (
    <Card variant="outlined" className={disclosure.expanded ? "ov-expanded" : undefined}>
    <CardContent className="ov-card-body">
      <CardHeading title="设备与硬件" />
      {identity}
      <Typography className="ov-section-title">ESC 硬件信息</Typography>
      {hardwareFamily(profile) !== profile && <Typography variant="caption" color="text.secondary">按 {hardwareFamily(profile)} 兼容定义解析</Typography>}
      {modelControl}
      {modelNote}
      {!decoded ? <Alert severity={slave.esc_hardware_error ? "warning" : "info"} sx={{ mt: 1 }}>
        {slave.esc_hardware_error ? `读取失败：${slave.esc_hardware_error}` : "当前扫描无可用数据"}
      </Alert> : <>
        <Box className="kv-compact" sx={{ mt: 1 }}>
          {/* ET1100 has no Microchip Chip ID at 0x0E02; that word is its own Power-On value. */}
          <Typography className="section-label">{decoded.family === "ET1100" ? "Product ID" : "Chip ID"}</Typography>
          <Typography variant="body2" className="mono ov-strong">{decoded.chipId}</Typography>
          <Typography className="section-label">硅版本</Typography>
          <Typography variant="body2" className="mono ov-strong">{decoded.revision}</Typography>
          <Typography className="section-label">Strap</Typography>
          <Typography variant="body2" className="mono ov-strong">{decoded.strap}</Typography>
          {eepromSize && <>
            <Typography className="section-label">EEPROM size strap</Typography>
            <Typography variant="body2" className="mono ov-strong">{eepromSize.meaning.replace("EEPROM 容量范围 ", "")}</Typography>
          </>}
        </Box>
        <Stack direction="row" gap={1.5} alignItems="baseline" sx={{ mt: 1, flexWrap: "wrap" }}>
          <Typography variant="body2" color="text.secondary" className="mono">0x0E00–0x0E07</Typography>
          <Typography variant="body2" className="mono ov-strong ov-hexline">{decoded.bytes.join(" ")}</Typography>
        </Stack>

        {decoded.mismatch && <Alert severity="warning" sx={{ mt: 0.75 }}>芯片标识与所选型号不一致，请核对 ESC 型号；不会自动切换或重配置。</Alert>}
        <span className="ov-card-tail">{disclosure.button}</span>
        <Collapse in={disclosure.expanded} id={disclosure.controls}>
          <TableContainer sx={{ mt: 0.75 }}>
            <Table size="small" className="overview-data-table">
              <TableHead><TableRow>{["Name", "Value", "地址 / Bit", "Description"].map((label) => <TableCell key={label} scope="col">{label}</TableCell>)}</TableRow></TableHead>
              <TableBody>
                {decoded.fields.filter((field) => !field.reserved).map((field) => (
                  <TableRow key={`${field.location}-${field.name}`} hover>
                    <TableCell>{field.name}</TableCell>
                    <TableCell className="mono ov-col-num">{field.value}</TableCell>
                    <TableCell className="mono ov-col-bit ov-nowrap">{field.location}</TableCell>
                    <TableCell className="ov-col-text">{field.meaning}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Collapse>
      </>}
    </CardContent>
    </Card>
  );
}
