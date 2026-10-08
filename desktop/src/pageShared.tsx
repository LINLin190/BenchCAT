import type { ReactNode } from "react";
import { Box, Card, CardContent, Stack, Typography } from "@mui/material";
import { DeveloperBoardRounded } from "@mui/icons-material";
import type { EsiDevice, SlaveInfo } from "./types";
const cardSx = { borderRadius: 1.25, minWidth: 0 };

export function slaveIdentityKey(slave?: SlaveInfo): string {
  if (!slave) return "none";
  const identity = slave.identity;
  return [slave.position, identity.vendor_id, identity.product_code, identity.revision, identity.serial_number, slave.configured_address ?? ""].join(":");
}

export function slaveDisplayName(slave: SlaveInfo): string {
  return slave.product_model || slave.name;
}

export function esiDeviceDisplayName(device: EsiDevice): string {
  return device.type_name || device.name;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2} sx={{ mb: 1.25 }}>
      <Box>
        <Typography variant="h5" fontWeight={750}>{title}</Typography>
        {subtitle && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.2 }}>{subtitle}</Typography>}
      </Box>
      {actions && <Stack direction="row" gap={1}>{actions}</Stack>}
    </Stack>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <Card sx={cardSx}>
      <CardContent sx={{ minHeight: 156, display: "grid", placeItems: "center", textAlign: "center" }}>
        <Stack alignItems="center" spacing={0.8} color="text.secondary">
          <DeveloperBoardRounded sx={{ fontSize: 36, opacity: 0.45 }} />
          <Typography>{text}</Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
