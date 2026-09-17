from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .bridge import BridgeRuntime, _json_value, _structured_error
from .infrastructure import default_audit_path
from .models import BackendMode

HOST_GENERATION = 1


class EventHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        subscriber: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=256)
        with self._lock:
            self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subscribers = tuple(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                if event.get("kind") == "heartbeat":
                    continue
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    pass
                try:
                    subscriber.put_nowait(event)
                except queue.Full:
                    pass


class WebEventWriter:
    def __init__(self, events: EventHub) -> None:
        self.events = events

    def event(self, kind: str, payload: Any, session_id: int | None = None) -> None:
        data = _json_value(payload)
        if kind == "bus_snapshot" and isinstance(data, dict):
            data["host_generation"] = HOST_GENERATION
        event: dict[str, Any] = {
            "kind": kind,
            "data": data,
            "host_generation": HOST_GENERATION,
        }
        if session_id is not None:
            event["session_id"] = session_id
        self.events.publish(event)


class WebBridgeService:
    def __init__(self, events: EventHub, *, audit_path: Path | None = None) -> None:
        self.events = events
        self.writer = WebEventWriter(events)
        # The standalone browser host is intentionally real-only. Demo remains a
        # desktop-only opt-in mode and cannot be selected through this transport.
        self.runtime = BridgeRuntime(
            self.writer,  # type: ignore[arg-type]
            BackendMode.REAL,
            audit_path=audit_path or default_audit_path(),
        )

    def snapshot(self) -> dict[str, Any]:
        snapshot = _json_value(self.runtime.snapshot())
        snapshot["host_generation"] = HOST_GENERATION
        return snapshot

    def request(
        self, method: str, params: dict[str, Any], session_id: int | None
    ) -> dict[str, Any]:
        spec = self.runtime.registry.require(method)
        if method == "switch_mode" and params.get("mode") != BackendMode.REAL.value:
            raise PermissionError("独立浏览器仅支持实际设备模式")
        if spec.lane == "hardware" and session_id is not None:
            if int(session_id) != self.runtime.session_id:
                raise RuntimeError("request belongs to an expired EtherCAT session")
        deadline_at_ms = int(time.time_ns() // 1_000_000) + spec.timeout_ms
        result = self.runtime.dispatch(method, params, deadline_at_ms=deadline_at_ms)
        snapshot = self.snapshot()
        return {
            "result": _json_value(result),
            "host_generation": HOST_GENERATION,
            "session_id": snapshot["session_id"],
            "snapshot": snapshot,
        }

    def shutdown(self) -> None:
        self.runtime.shutdown()


class WebBridgeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], service: WebBridgeService) -> None:
        super().__init__(address, WebBridgeHandler)
        self.service = service


class WebBridgeHandler(BaseHTTPRequestHandler):
    server: WebBridgeServer
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send_json(self, status: HTTPStatus, value: Any) -> None:
        payload = json.dumps(_json_value(value), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > self.server.service.runtime.registry.max_frame_bytes:
            raise ValueError("请求体大小无效")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return value

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._send_json(
                HTTPStatus.OK,
                {"ready": True, "mode": BackendMode.REAL.value, "host_generation": HOST_GENERATION},
            )
            return
        if self.path != "/api/events":
            self._send_json(HTTPStatus.NOT_FOUND, {"message": "Not found"})
            return
        subscriber = self.server.service.events.subscribe()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        initial = {
            "kind": "bus_snapshot",
            "data": self.server.service.snapshot(),
            "host_generation": HOST_GENERATION,
            "session_id": self.server.service.runtime.session_id,
        }
        try:
            self._write_event(initial)
            while True:
                try:
                    event = subscriber.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    continue
                self._write_event(event)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.server.service.events.unsubscribe(subscriber)

    def _write_event(self, event: dict[str, Any]) -> None:
        payload = json.dumps(_json_value(event), ensure_ascii=False, separators=(",", ":"))
        self.wfile.write(f"data: {payload}\n\n".encode())
        self.wfile.flush()

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._read_json()
            if self.path == "/api/bridge":
                self._bridge_request(body)
            elif self.path == "/api/dialog/file":
                self._send_json(HTTPStatus.OK, {"path": _pick_file(body.get("extensions", []))})
            elif self.path == "/api/dialog/directory":
                self._send_json(HTTPStatus.OK, {"path": _pick_directory()})
            elif self.path == "/api/reveal":
                _reveal_path(Path(str(body.get("path", ""))))
                self._send_json(HTTPStatus.OK, {"revealed": True})
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"message": "Not found"})
        except BaseException as exc:
            if self.path == "/api/bridge":
                method = str(locals().get("body", {}).get("method") or "")
                spec = self.server.service.runtime.registry.commands.get(method)
                snapshot = self.server.service.snapshot()
                error = _structured_error(
                    exc,
                    request_id=0,
                    method=method,
                    spec=spec,
                    session_id=snapshot["session_id"],
                    snapshot=snapshot,
                )
                error["host_generation"] = HOST_GENERATION
                self._send_json(HTTPStatus.BAD_REQUEST, error)
            else:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"code": "HOST_ACTION", "message": str(exc), "operation_result": "failed"},
                )

    def _bridge_request(self, body: dict[str, Any]) -> None:
        method = str(body.get("method") or "")
        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("params 必须是 JSON 对象")
        session_id = body.get("session_id")
        envelope = self.server.service.request(
            method, params, int(session_id) if session_id is not None else None
        )
        self._send_json(HTTPStatus.OK, envelope)


def _pick_file(extensions: Any) -> str | None:
    import tkinter as tk
    from tkinter import filedialog

    normalized = [str(item).lstrip(".") for item in extensions if str(item).strip(".")]
    patterns = " ".join(f"*.{item}" for item in normalized) or "*.*"
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askopenfilename(
            title="选择文件", filetypes=[("支持的文件", patterns), ("所有文件", "*.*")]
        )
        return selected or None
    finally:
        root.destroy()


def _pick_directory() -> str | None:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(title="选择目录")
        return selected or None
    finally:
        root.destroy()


def _reveal_path(path: Path) -> None:
    target = path.resolve()
    if not target.exists():
        raise FileNotFoundError(f"路径不存在：{target}")
    if os.name != "nt":
        raise RuntimeError("打开文件位置目前仅支持 Windows")
    argument = f"/select,{target}" if target.is_file() else str(target)
    subprocess.Popen(["explorer.exe", argument])


def main() -> int:
    parser = argparse.ArgumentParser(description="BenchCAT standalone browser bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1421)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        parser.error("web bridge may only bind to localhost")
    events = EventHub()
    service = WebBridgeService(events)
    server = WebBridgeServer((args.host, args.port), service)
    print(f"BenchCAT real bridge listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        service.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
