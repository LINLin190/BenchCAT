from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def default_library_index_path() -> Path:
    root = os.environ.get("LOCALAPPDATA")
    base = Path(root) if root else Path.home() / ".cache"
    return base / "BenchCAT" / "cache" / "esi-library-index.json"


class LibraryIndex:
    """Persist list metadata only; programming sources are always loaded separately."""

    def __init__(self, path: Path | None, limit: int = 256) -> None:
        self.path = path
        self.limit = limit
        self._loaded = False
        self._dirty = False
        self._sources: dict[str, dict[str, Any]] = {}

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self.path is None:
            return
        try:
            # Bound disk-cache input as well as the number of retained sources.
            if self.path.stat().st_size > 16 * 1024 * 1024:
                return
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if value.get("version") == 1 and isinstance(value.get("sources"), dict):
                self._sources = dict(list(value["sources"].items())[-self.limit:])
        except (OSError, ValueError, AttributeError):
            pass

    def get(self, source: Path, stamp: tuple[int, int]) -> list[dict[str, Any]] | None:
        self._load()
        value = self._sources.get(str(source))
        if not isinstance(value, dict) or value.get("stamp") != list(stamp):
            return None
        try:
            entries = value["entries"]
            if not isinstance(entries, list):
                return None
            strings = ("path", "sha256", "vendor_name", "device_name", "type_name", "config_data")
            numbers = ("vendor_id", "ordinal", "product_code", "revision", "byte_size")
            if not all(isinstance(entry, dict)
                       and all(isinstance(entry.get(key), str) for key in strings)
                       and all(type(entry.get(key)) is int for key in numbers)
                       and entry["path"] == str(source) for entry in entries):
                return None
            return [{**entry, "config_data": bytes.fromhex(entry["config_data"])} for entry in entries]
        except (KeyError, TypeError, ValueError):
            return None

    def remember(self, source: Path, stamp: tuple[int, int], entries: list[dict[str, Any]]) -> None:
        self._load()
        key = str(source)
        value = {"stamp": list(stamp), "entries": [{**entry, "config_data": entry["config_data"].hex()} for entry in entries]}
        if self._sources.get(key) == value:
            return
        self._sources.pop(key, None)
        self._sources[key] = value
        while len(self._sources) > self.limit:
            self._sources.pop(next(iter(self._sources)))
        self._dirty = True

    def forget(self, source: Path) -> None:
        self._load()
        if str(source) in self._sources:
            self._sources.pop(str(source))
            self._dirty = True

    def prune(self, directory: Path, sources: set[Path]) -> None:
        self._load()
        for key in list(self._sources):
            path = Path(key)
            if path.parent == directory and path not in sources:
                self.forget(path)

    def flush(self) -> None:
        if not self._dirty or self.path is None:
            return
        temporary: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump({"version": 1, "sources": self._sources}, stream, ensure_ascii=False, separators=(",", ":"))
            temporary.replace(self.path)
            self._dirty = False
        except OSError:
            # A read-only cache location must not prevent listing or selecting files.
            pass
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
