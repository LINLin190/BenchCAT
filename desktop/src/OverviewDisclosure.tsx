import type { ReactNode } from "react";
import { useState } from "react";
import { Button, Stack, Typography } from "@mui/material";
import { ExpandLessRounded, ExpandMoreRounded } from "@mui/icons-material";

/**
 * One disclosure affordance for every overview card, so "展开…" buttons sit at the same
 * place with the same typography, and the expanded detail is rendered *inside* its own
 * card instead of as a detached card further down the page.
 */
export function useDisclosure(label: string, controls: string) {
  const [expanded, setExpanded] = useState(false);
  const button: ReactNode = (
    <Button
      size="small"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={() => setExpanded((value) => !value)}
      endIcon={expanded ? <ExpandLessRounded /> : <ExpandMoreRounded />}
      sx={{ px: 0, minHeight: 26, mt: 0.5 }}
    >
      {expanded ? `收起${label}` : `展开${label}`}
    </Button>
  );
  return { expanded, controls, button };
}

/** Shared card title: one heading style, an optional trailing note, and an optional action slot
 *  so a card-level disclosure button can sit on the title line. */
export function CardHeading({ title, note, action }: { title: string; note?: ReactNode; action?: ReactNode }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={1} sx={{ mb: 1.25 }}>
      <Typography variant="h6">{title}</Typography>
      <Stack direction="row" alignItems="center" gap={1.5}>
        {note === undefined || note === null ? null : (
          <Typography variant="caption" color="text.secondary" className="mono">{note}</Typography>
        )}
        {action ? <Stack sx={{ "& .MuiButton-root": { mt: 0, minHeight: 22, py: 0 } }}>{action}</Stack> : null}
      </Stack>
    </Stack>
  );
}
