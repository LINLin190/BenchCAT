from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class AuditLogger:
    def __init__(self, path: Path | None, *, max_bytes: int = 5 * 1024 * 1024, backups: int = 3) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self.backups = backups
        self._lock = threading.Lock()

    def _rotate_if_needed(self, incoming_bytes: int) -> None:
        if self.path is None or self.backups < 1 or not self.path.exists():
            return
        if self.path.stat().st_size + incoming_bytes <= self.max_bytes:
            return
        for index in range(self.backups, 0, -1):
            source = self.path if index == 1 else self.path.with_name(f"{self.path.name}.{index - 1}")
            destination = self.path.with_name(f"{self.path.name}.{index}")
            if not source.exists():
                continue
            if destination.exists():
                destination.unlink()
            source.replace(destination)

    def record(
        self,
        action: str,
        details: dict[str, Any],
        *,
        outcome: str,
        error: str | None = None,
    ) -> None:
        if self.path is None:
            return
        payload = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": "AUDIT",
            "action": action,
            "outcome": outcome,
            "details": details,
        }
        if error:
            payload["error"] = error
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._rotate_if_needed(len((encoded + "\n").encode("utf-8")))
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(encoded + "\n")


def default_audit_path() -> Path:
    import os

    root = os.environ.get("LOCALAPPDATA")
    base = Path(root) if root else Path.cwd()
    return base / "BenchCAT" / "logs" / "audit.jsonl"
