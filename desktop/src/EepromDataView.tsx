import { useEffect, useState } from "react";
import { Alert, Button, Card, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { BridgeRequestError, bridgeRequest } from "./api";
import { EepromHexView } from "./EepromHexView";
import { type ImageSnapshot } from "./eepromViewModel";

type ReadSnapshot = ImageSnapshot & { read_at: string; sii_valid: boolean; category_count?: number; sii_error?: string };

// Keep target bytes attached to the frozen image without issuing another device read.
export function EepromDataView({ read, targetId, fullRead }: { read?: ReadSnapshot; targetId?: string; fullRead: boolean }) {
  const [source, setSource] = useState<"read" | "target">("read");
  const [snapshot, setSnapshot] = useState<{ id: string; image?: ImageSnapshot; error?: string }>();
  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    void bridgeRequest<ImageSnapshot>("eeprom_target_data", { target_id: targetId }).then(image => {
      if (!cancelled) setSnapshot({ id: targetId, image });
    }).catch(error => {
      if (!cancelled) setSnapshot({ id: targetId, error: error instanceof BridgeRequestError ? error.message : "无法读取目标镜像，请重新选择文件。" });
    });
    return () => { cancelled = true; };
  }, [targetId]);
  useEffect(() => { if (!targetId) setSource("read"); }, [targetId]);
  const target = snapshot?.id === targetId ? snapshot?.image : undefined;
  const targetError = snapshot?.id === targetId ? snapshot?.error : undefined;
  const displayed = source === "read" ? read : target;

  return <Card className={`eeprom-data${displayed?.data ? " eeprom-data-loaded" : ""}`} variant="outlined">
    <Stack direction="row" alignItems="center" gap={1} className="eeprom-data-heading">
      <Typography fontWeight={750} sx={{ mr: 1 }}>Hex数据</Typography>
      <Button size="small" variant={source === "read" ? "contained" : "text"} onClick={() => setSource("read")}>设备读取</Button>
      <Button size="small" variant={source === "target" ? "contained" : "text"} disabled={!target} onClick={() => setSource("target")}>目标镜像</Button>
      <Chip size="small" variant="outlined" label="只读" sx={{ ml: "auto" }} />
      {targetId && !target && !targetError && <CircularProgress size={14} />}
    </Stack>
    {displayed && <Stack className="eeprom-read-meta">
      <Typography variant="caption" color="text.secondary">{source === "read" && read
        ? `${read.size} B · ${new Date(read.read_at).toLocaleString()} · SII：${read.sii_valid ? `${read.category_count ?? 0} 个 Category` : fullRead ? "无法解析" : "当前范围内未解析"}`
        : `${target?.size} B · 当前待写入镜像`}</Typography>
    </Stack>}
    {targetError && <Alert severity="error">{targetError}</Alert>}
    {/* Only target bytes receive difference colors; unread device bytes stay unclassified. */}
    <EepromHexView key={source} data={displayed?.data} comparisonData={source === "target" ? read?.data : undefined} />
  </Card>;
}
