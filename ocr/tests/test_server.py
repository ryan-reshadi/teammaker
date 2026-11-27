from __future__ import annotations

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

TESTS = os.path.dirname(os.path.abspath(__file__))
OCR = os.path.dirname(TESTS)
sys.path.insert(0, OCR)
sys.path.insert(0, TESTS)

from fixtures import FakeReader, build  # noqa: E402
from rivals_ocr.server import create_server  # noqa: E402

ROWS = [
    {"username": "sniperking", "damage": 12000, "team": "gold"},
    {"username": "purplepal", "damage": 4000, "team": "purple"},
]


class ServerTests(unittest.TestCase):
    token = "test-token"

    def start(self, max_bytes: int = 8 * 1024 * 1024):
        png, spec = build(ROWS)
        self.png = png
        self.server = create_server(
            FakeReader(spec),
            token=self.token,
            host="127.0.0.1",
            port=0,
            max_bytes=max_bytes,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        host, port = self.server.server_address[:2]
        self.base = f"http://{host}:{port}"

    def post(self, data: bytes, token: str | None = None, path: str = "/scan"):
        headers = {"Content-Type": "image/png"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            self.base + path, data=data, method="POST", headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_scan_returns_the_extraction(self):
        self.start()
        status, body = self.post(self.png, token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body["teams"][0]["score"], 5)
        self.assertEqual(body["rows"][0]["damage"], 12000)
        self.assertEqual(body["winnerSlot"], 0)

    def test_scan_requires_the_token(self):
        self.start()
        status, body = self.post(self.png)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_scan_rejects_a_foreign_token(self):
        self.start()
        status, _body = self.post(self.png, token="not-the-token")
        self.assertEqual(status, 401)

    def test_scan_rejects_non_images(self):
        self.start()
        status, body = self.post(b"<html>nope</html>", token=self.token)
        self.assertEqual(status, 415)
        self.assertEqual(body["error"]["code"], "unsupported_type")

    def test_scan_rejects_oversized_uploads(self):
        self.start(max_bytes=1000)
        status, body = self.post(self.png, token=self.token)
        self.assertEqual(status, 413)
        self.assertEqual(body["error"]["code"], "too_large")

    def test_health_is_a_liveness_probe(self):
        self.start()
        with urllib.request.urlopen(self.base + "/health", timeout=10) as response:
            body = json.loads(response.read())
        self.assertTrue(body["ok"])
        self.assertEqual(body["engine"], "fake")

    def test_unknown_routes_are_not_found(self):
        self.start()
        status, body = self.post(self.png, token=self.token, path="/other")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")


if __name__ == "__main__":
    unittest.main()
