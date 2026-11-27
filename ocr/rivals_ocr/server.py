"""A small HTTP interface for the OCR pipeline, standard library only.

`POST /scan` takes the raw image bytes (no multipart parsing needed) and returns
the structured extraction. `GET /health` is a liveness probe. Every scan needs
the shared bearer token; images are processed in memory and never written to
disk or logged.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .imaging import DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION, ImageError
from .layout import ScoreboardError
from .pipeline import scan_image
from .recognize import EngineUnavailable, PaddleTextReader


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "RivalsOCR/1"

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib name
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send(status, {"ok": False, "error": {"code": code, "message": message}})

    def _authorized(self) -> bool:
        expected = f"Bearer {self.server.token}"
        provided = self.headers.get("Authorization", "")
        return hmac.compare_digest(provided, expected)

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        path = urlparse(self.path).path
        if path != "/health":
            self._error(404, "not_found", "Unknown route.")
            return
        self._send(
            200,
            {
                "ok": True,
                "version": 1,
                "engine": self.server.reader.name,
            },
        )

    def do_POST(self) -> None:  # noqa: N802 - stdlib name
        path = urlparse(self.path).path
        if path != "/scan":
            self._error(404, "not_found", "Unknown route.")
            return
        if not self._authorized():
            self._error(401, "unauthorized", "A bearer token is required.")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._error(400, "invalid_image", "The upload is empty.")
            return
        if length > self.server.max_bytes:
            self._error(
                413,
                "too_large",
                f"Screenshots are up to {self.server.max_bytes // (1024 * 1024)} MB.",
            )
            return
        data = self.rfile.read(length)
        try:
            result = scan_image(
                data,
                self.server.reader,
                self.server.max_bytes,
                self.server.max_dimension,
            )
        except ImageError as error:
            self._error(error.status, error.code, error.message)
        except ScoreboardError as error:
            self._error(error.status, error.code, str(error))
        except EngineUnavailable as error:
            print(f"rivals-ocr: engine unavailable: {error}", file=sys.stderr, flush=True)
            self._error(
                503,
                "engine_unavailable",
                "The OCR engine is unavailable on this service.",
            )
        except Exception:  # noqa: BLE001 - the reply must stay generic
            # The traceback goes to the service log; no image data is included.
            traceback.print_exc(file=sys.stderr)
            self._error(
                500,
                "engine_unavailable",
                "The OCR engine failed on this image.",
            )
        else:
            self._send(200, result)


def create_server(
    reader,
    token: str,
    host: str = "127.0.0.1",
    port: int = 8000,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.reader = reader
    server.token = token
    server.max_bytes = max_bytes
    server.max_dimension = max_dimension
    server.verbose = os.environ.get("OCR_VERBOSE") == "1"
    return server


def run() -> None:
    token = os.environ.get("OCR_SERVICE_TOKEN", "").strip()
    if not token:
        print(
            "rivals-ocr: set OCR_SERVICE_TOKEN to a long random string; the service refuses to start without it.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    host = os.environ.get("OCR_HOST", "127.0.0.1")
    port = int(os.environ.get("OCR_PORT", "8000"))
    max_bytes = int(os.environ.get("OCR_MAX_BYTES", str(DEFAULT_MAX_BYTES)))
    max_dimension = int(os.environ.get("OCR_MAX_DIMENSION", str(DEFAULT_MAX_DIMENSION)))
    reader = PaddleTextReader(lang=os.environ.get("OCR_LANG", "en"))
    # Bind before loading the models: a second instance on a busy port should
    # fail in a second with the reason, not after a minute of model loading.
    try:
        server = create_server(reader, token, host, port, max_bytes, max_dimension)
    except OSError as error:
        print(
            f"rivals-ocr: cannot listen on {host}:{port} ({error}). "
            "Another instance may already be running; stop it or set OCR_PORT.",
            file=sys.stderr,
        )
        raise SystemExit(2) from error
    try:
        reader.warmup()
    except EngineUnavailable as error:
        server.server_close()
        print(f"rivals-ocr: {error}", file=sys.stderr)
        raise SystemExit(2)
    print(
        f"rivals-ocr: listening on http://{host}:{port} (engine={reader.name})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
