"""The real PaddleOCR engine behind the pipeline's reader seam.

These tests deliberately use the production engine instead of the fixture reader,
so a failure here means the engine adapter or the crop contract is wrong, while a
failure in the fixture tests means the layout geometry is wrong. They are skipped
when PaddleOCR is not installed (the pipeline tests never need it) or when
`OCR_SKIP_ENGINE=1` is set, because loading the models costs a few seconds.
"""

from __future__ import annotations

import os
import sys
import time
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
OCR = os.path.dirname(TESTS)
sys.path.insert(0, OCR)
sys.path.insert(0, TESTS)

from fixtures import build  # noqa: E402
from rivals_ocr.imaging import crop  # noqa: E402
from rivals_ocr.layout import analyze, damage_column  # noqa: E402
from rivals_ocr.pipeline import analyze_image, scan_image  # noqa: E402
from rivals_ocr.recognize import PaddleTextReader  # noqa: E402

try:  # The engine is optional for everyone but the service host.
    import paddleocr  # noqa: F401

    HAVE_PADDLE = True
except Exception:  # pragma: no cover - depends on the host
    HAVE_PADDLE = False

ROWS = [
    {"username": "sniperking", "damage": 12345, "team": "gold"},
    {"username": "ZeroHero", "damage": 0, "team": "gold"},
    {"username": "ghostwalker", "damage": 812, "team": "gold"},
    {"username": "purplepal", "damage": 4321, "team": "purple"},
    {"username": "nightowl", "damage": 77, "team": "purple"},
]


@unittest.skipUnless(HAVE_PADDLE, "PaddleOCR is not installed (pip install -r ocr/requirements.txt)")
@unittest.skipIf(os.environ.get("OCR_SKIP_ENGINE") == "1", "OCR_SKIP_ENGINE=1")
class PaddleEngineTests(unittest.TestCase):
    """One engine instance for the class: model loading dominates the runtime."""

    @classmethod
    def setUpClass(cls):
        cls.reader = PaddleTextReader()
        started = time.time()
        cls.reader.warmup()
        cls.warmup_seconds = time.time() - started
        cls.png, _spec = build(ROWS)
        # One full scan shared by the assertions: Paddle inference is the slow part.
        cls.result = scan_image(cls.png, cls.reader)
        cls.scan_seconds = time.time() - started - cls.warmup_seconds
        print(
            f"\n  paddle engine: warmup {cls.warmup_seconds:.1f}s, "
            f"scan {cls.scan_seconds:.1f}s",
            flush=True,
        )

    def test_reader_honours_the_text_line_contract(self):
        # A raw crop through the reader: real Paddle boxes, scores and text.
        image = crop(_fixture_image(self.png), _header_box(self.png))
        lines = self.reader.read(image, "header")
        self.assertTrue(lines, "PaddleOCR returned no lines for the header crop")
        height, width = image.shape[:2]
        for line in lines:
            self.assertIsInstance(line.text, str)
            self.assertTrue(line.text.strip())
            self.assertGreaterEqual(line.confidence, 0.0)
            self.assertLessEqual(line.confidence, 1.0)
            x0, y0, x1, y1 = line.box
            self.assertGreaterEqual(x0, -1.0)
            self.assertGreaterEqual(y0, -1.0)
            self.assertLessEqual(x1, width + 1.0)
            self.assertLessEqual(y1, height + 1.0)
        texts = " ".join(line.text for line in lines).upper()
        self.assertIn("DMG", texts.replace(" ", ""))

    def test_header_column_is_located_from_real_ocr(self):
        image = _fixture_image(self.png)
        layout = analyze(_hsv(image))
        self.assertIsNotNone(layout.header)
        lines = self.reader.read(crop(image, layout.header), "header")
        column = damage_column(lines, layout.row_height)
        self.assertIsNotNone(column)
        # EDA and PING sit right of DMG; the column must land on DMG instead.
        self.assertGreater(column.center, layout.panel[0])
        self.assertLess(column.center, layout.panel[2])

    def test_every_row_username_and_damage_parse(self):
        result = self.result

        self.assertEqual(result["image"], {"width": 1280, "height": 760})
        self.assertEqual(len(result["rows"]), len(ROWS))
        self.assertEqual(result["issues"], [])

        for expected, row in zip(ROWS, result["rows"]):
            with self.subTest(row=expected["username"]):
                self.assertEqual(row["username"], expected["username"])
                self.assertEqual(row["damage"], expected["damage"])
                self.assertEqual(row["color"], expected["team"])
                self.assertEqual(row["issues"], [])
                self.assertGreater(row["usernameConfidence"], 0.0)
                self.assertGreater(row["damageConfidence"], 0.0)

        self.assertEqual([team["score"] for team in result["teams"]], [5, 3])
        self.assertEqual(result["winnerSlot"], 0)

    def test_zero_damage_survives_real_recognition(self):
        zero = next(row for row in self.result["rows"] if row["username"] == "ZeroHero")
        self.assertEqual(zero["damage"], 0)
        self.assertEqual(zero["rawDamageText"], "0")
        self.assertNotIn("damage_unreadable", [i["code"] for i in zero["issues"]])


def _fixture_image(png: bytes):
    import numpy as np
    import cv2

    return cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)


def _hsv(image):
    import cv2

    return cv2.cvtColor(image, cv2.COLOR_BGR2HSV)


def _header_box(png: bytes):
    image = _fixture_image(png)
    layout = analyze(_hsv(image))
    return layout.header


if __name__ == "__main__":
    unittest.main()
