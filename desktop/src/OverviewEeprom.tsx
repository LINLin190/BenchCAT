import { Alert, Box, Card, CardContent, Collapse, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { CardHeading, useDisclosure } from "./OverviewDisclosure";
import { decodeEepromPrefix, decodeEepromStatus, type EepromFamily } from "./eepromDiagnostics";
import { hardwareFamily } from "./escHardware";
import type { SlaveInfo } from "./types";

/** The EEPROM prefix words share the ESC register numbering, so the profile picks them. */
function eepromFamily(profile: string): EepromFamily {
  const family = hardwareFamily(profile);
  return family === "LAN9252" || family === "LAN9253" ? family : "ET1100";
}

/** Field name and decoded value lead, the bit position trails: the text column must own the
 *  flexible width, otherwise it wraps several lines deep once the detail table expands. */
const BIT_TABLE_COLUMNS = ["Name", "Value", "Bit", "Description"];

function HeadRow({ labels }: { labels: string[] }) {
  return (
    <TableHead>
      <TableRow>{labels.map((label) => <TableCell key={label} scope="col">{label}</TableCell>)}</TableRow>
    </TableHead>
  );
}

/**
 * EEPROM diagnostics. Collapsed it answers the two questions an operator actually has: what the
 * configuration bytes say (0x0140 / 0x0150) and what the control/status register reports right
 * now. Expanding adds the full sixteen-byte word decode and the control/status bit fields.
 */
export function OverviewEeprom({ slave, profile }: { slave: SlaveInfo; profile: string }) {
  const status = decodeEepromStatus(slave.eeprom_status);
  const prefix = decodeEepromPrefix(slave.eeprom_prefix, eepromFamily(profile));
  const disclosure = useDisclosure("详情", "eeprom-details");

  return (
    <Card variant="outlined" className={disclosure.expanded ? "ov-expanded" : undefined}>
      <CardContent className="ov-card-body">
        <CardHeading title="EEPROM 诊断" />
        <div className="ov-eeprom-pair">
          <section>
            <Typography className="ov-section-title">配置区 · 前 16 字节</Typography>
            {!prefix ? <Alert severity={slave.eeprom_prefix_error ? "warning" : "info"} sx={{ mt: 0.75 }}>{slave.eeprom_prefix_error || "无可用 EEPROM 数据"}</Alert> : <>
              <Box className="ov-raw-row" sx={{ mt: 0.75 }}>
                <Typography variant="caption" color="text.secondary">0000:</Typography>
                <Typography variant="body2" className="mono ov-hexline">{prefix.raw}</Typography>
              </Box>
              <TableContainer sx={{ mt: 0.75 }}>
                <Table size="small" className="overview-data-table ov-pair-table">
                  <TableBody>
                    {prefix.rows.map((row) => (
                      <TableRow key={row.register} hover>
                        <TableCell>{row.name}<Typography component="span" variant="caption" color="text.secondary" className="mono">（{row.register}）</Typography></TableCell>
                        <TableCell className="ov-col-text">
                          <Typography component="span" variant="body2" className="mono ov-strong">{row.value}</Typography>
                          {row.headline ? <Typography component="span" variant="body2" color="text.secondary"> · {row.headline}</Typography> : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>}
          </section>
          <section>
            <Typography className="ov-section-title">控制 / 状态 · 0x0502–0x0503</Typography>
            {!status ? <Alert severity={slave.eeprom_status_error ? "warning" : "info"} sx={{ mt: 0.75 }}>{slave.eeprom_status_error || "无可用寄存器数据"}</Alert> : <>
              <Box className="ov-raw-row" sx={{ mt: 0.75 }}>
                <Typography variant="caption" color="text.secondary">Raw value</Typography>
                <Typography variant="body2" className="mono ov-strong">{status.raw}</Typography>
                <Typography variant="caption" color="text.secondary">Binary</Typography>
                <Typography variant="body2" className="mono ov-binary">{status.binary}</Typography>
              </Box>
              <TableContainer sx={{ mt: 0.75 }}>
                <Table size="small" className="overview-data-table ov-pair-table">
                  <TableBody>
                    {status.summary.map((field) => (
                      <TableRow key={field.bits} hover className={field.error ? "ov-row-error" : undefined}>
                        <TableCell>{field.name}</TableCell>
                        <TableCell className="ov-col-text">{field.description}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>}
          </section>
        </div>
        <span className="ov-card-tail">{disclosure.button}</span>
        {/* Detail: the prefix word decode and the control/status bit fields. */}
        <Collapse in={disclosure.expanded} id={disclosure.controls} unmountOnExit>
          <div className="ov-eeprom-details">
            {prefix && <section>
              <Typography variant="caption" className="mono ov-group-title">配置区 · 前 16 字节解析</Typography>
              <TableContainer>
                <Table size="small" className="overview-data-table ov-word-table">
                  <HeadRow labels={["Word", "16-bit 值", "解析"]} />
                  <TableBody>
                    {prefix.words.map((row) => (
                      <TableRow key={row.word} hover>
                        <TableCell className="mono ov-nowrap">{row.word}</TableCell>
                        <TableCell className="mono ov-nowrap">{row.value}</TableCell>
                        <TableCell className="ov-col-text">{row.parse}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </section>}
            {status && <section>
              <Typography variant="caption" className="mono ov-group-title">控制 / 状态 · 0x0502–0x0503 · <b>{status.raw}</b></Typography>
              <TableContainer>
                <Table size="small" className="overview-data-table">
                  <HeadRow labels={BIT_TABLE_COLUMNS} />
                  <TableBody>
                    {status.fields.map((field) => (
                      <TableRow key={field.bits} className={field.error ? "ov-row-error" : undefined}>
                        <TableCell>{field.name}</TableCell>
                        <TableCell className="mono ov-col-num">{field.binary}</TableCell>
                        <TableCell className="mono ov-col-bit">{field.bits}</TableCell>
                        <TableCell className="ov-col-text">
                          {field.description}
                          {field.detail ? <Typography component="span" variant="caption" color="text.secondary">（{field.detail}）</Typography> : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </section>}
          </div>
        </Collapse>
      </CardContent>
    </Card>
  );
}
