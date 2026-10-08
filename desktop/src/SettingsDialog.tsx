import { useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl, InputLabel, MenuItem, Select, Stack, Switch, Tab, Tabs, Typography } from "@mui/material";
import { BugReportRounded, GitHub as GitHubIcon, InfoOutlineRounded, OpenInNewRounded, RefreshRounded, SettingsRounded } from "@mui/icons-material";
import packageInfo from "../package.json";
import type { AlStatusLanguage } from "./alStatus";
const brandIconUrl = new URL("./assets/BenchCAT.png", import.meta.url).href;
const PROJECT_URL = "https://github.com/LINLin190/BenchCAT";
const DOWNLOAD_URL = `${PROJECT_URL}/releases/latest`;
const ISSUES_URL = `${PROJECT_URL}/issues`;
interface Props {
  onClose: () => void;
  alLanguage: AlStatusLanguage;
  onLanguageChange: (value: AlStatusLanguage) => void;
  autoCheckUpdates: boolean;
  onAutoCheckChange: (value: boolean) => void;
  updateState: string;
  updateError?: string;
  updateStageLabel?: string;
  updating: boolean;
  availableVersion?: string;
  ignoredUpdateVersion: string;
  pendingUpdateReminder: boolean;
  visit: (url: string) => void;
  checkUpdate: () => Promise<boolean>;
  onShowUpdate: () => void;
  onShowAvailableUpdate: () => void;
}
export function SettingsDialog({ onClose, alLanguage, onLanguageChange, autoCheckUpdates, onAutoCheckChange, updateState, updateError, updateStageLabel, updating, availableVersion, ignoredUpdateVersion, pendingUpdateReminder, visit, checkUpdate, onShowUpdate, onShowAvailableUpdate }: Props) {
  const [settingsTab, setSettingsTab] = useState(0);
  return <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ pb: 1 }}>设置</DialogTitle>
      <Tabs value={settingsTab} onChange={(_, value) => setSettingsTab(value)} sx={{ px: 2.5, minHeight: 42 }}>
        <Tab icon={<SettingsRounded fontSize="small" />} iconPosition="start" label="通用" sx={{ minHeight: 42 }} />
        <Tab icon={<InfoOutlineRounded fontSize="small" />} iconPosition="start" label="关于" sx={{ minHeight: 42 }} />
      </Tabs>
      <Divider />
      <DialogContent sx={{ minHeight: 360 }}>
        {settingsTab === 0 ? <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>AL 状态码语言</Typography><Typography variant="body2" color="text.secondary">切换概览页 AL 状态名称、说明与排查建议。</Typography></Box><FormControl size="small" sx={{ width: 150 }}><InputLabel>Language</InputLabel><Select label="Language" value={alLanguage} onChange={(event) => onLanguageChange(event.target.value as AlStatusLanguage)}><MenuItem value="zh">中文</MenuItem><MenuItem value="en">English</MenuItem></Select></FormControl></Box>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>自动检查更新</Typography><Typography variant="body2" color="text.secondary">开启后发现新版本会显示更新弹窗；关闭后启动时仅在右下角短暂提示，仍可在“关于”页面手动检查。</Typography></Box><Switch checked={autoCheckUpdates} onChange={(event) => onAutoCheckChange(event.target.checked)} /></Box>
        </Stack> : <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "#F8FAFF" }}>
            <Box component="img" src={brandIconUrl} alt="BenchCAT" sx={{ width: 72, height: 72, borderRadius: 1.5, display: "block", flexShrink: 0 }} />
            <Box sx={{ minWidth: 0, flex: 1 }}><Stack direction="row" alignItems="center" gap={1}><Typography variant="h6">BenchCAT</Typography><Chip size="small" variant="outlined" label={`v${packageInfo.version}`} /></Stack><Typography variant="body2" color="text.secondary">面向 Windows 的 EtherCAT 从站调试与诊断工作台</Typography></Box>
          </Box>
          <Typography variant="body2" color="text.secondary">聚焦从站概览、ESC 标准寄存器诊断与 EEPROM 原始读取、BIN 文件导出及 XML/BIN 烧录。硬件通信由独立 Python Bridge 与 Worker 串行执行。</Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1.2 }}>
            {[["版本", packageInfo.version], ["通信核心", "pySOEM 1.1.13"], ["许可证", "PolyForm NC 1.0"]].map(([label, value]) => <Box key={label} sx={{ p: 1.4, border: 1, borderColor: "divider", borderRadius: 1 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" fontWeight={700} sx={{ mt: 0.3 }}>{value}</Typography></Box>)}
          </Box>
          <Divider />
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button variant="contained" startIcon={<GitHubIcon />} endIcon={<OpenInNewRounded fontSize="small" />} onClick={() => visit(PROJECT_URL)}>GitHub 项目</Button>
            <Button variant="outlined" startIcon={<BugReportRounded />} endIcon={<OpenInNewRounded fontSize="small" />} onClick={() => visit(ISSUES_URL)}>问题反馈</Button>
            <Button variant="outlined" startIcon={updateState === "checking" ? <CircularProgress size={16} /> : <RefreshRounded />} disabled={updateState === "checking" || updating} onClick={() => void checkUpdate()}>{updateState === "checking" ? "正在检查…" : "检查更新"}</Button>
          </Stack>
          {updateState === "latest" && <Alert severity="success">当前已是最新版本。</Alert>}
          {updateState === "error" && updateError && <Alert severity="warning" action={<Stack direction="row"><Button color="inherit" size="small" onClick={() => visit(DOWNLOAD_URL)}>GitHub 手动下载</Button><Button color="inherit" size="small" onClick={onShowUpdate}>查看详情</Button></Stack>} sx={{ overflowWrap: "anywhere" }}>{updateError}</Alert>}
          {availableVersion && updateState === "available" && <Alert severity="info" action={<Button color="inherit" size="small" onClick={onShowAvailableUpdate}>查看更新</Button>}>{ignoredUpdateVersion === availableVersion ? `已忽略 v${availableVersion} 的自动提醒，仍可手动更新。` : `发现 v${availableVersion} 更新。${pendingUpdateReminder ? "设备操作结束后将显示更新弹窗。" : ""}`}</Alert>}
          {updating && <Alert severity="info" action={<Button color="inherit" size="small" onClick={onShowUpdate}>查看进度</Button>}>{updateStageLabel}，请保持软件运行。</Alert>}
          <Typography variant="caption" color="text.secondary">Copyright © BenchCAT contributors</Typography>
        </Stack>}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>完成</Button></DialogActions>
    </Dialog>;
}
