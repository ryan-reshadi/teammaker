"""Real screenshots, measured instead of assumed.

The suite never needs these files: with no capture the whole class is skipped, so
a fresh checkout stays green. Add a screenshot plus its `.truth.json` sidecar to
`ocr/tests/captures/` and the same checks that guard the synthetic fixtures start
guarding real captures too. `python ocr/tools/measure_captures.py` prints the
per-row diff when one fails.
"""

from __future__ import annotations

import os
import sys
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
OCR = os.path.dirname(TESTS)
sys.path.insert(0, OCR)
sys.path.insert(0, TESTS)

from rivals_ocr.captures import (  # noqa: E402
    DEFAULT_THRESHOLDS,
    format_capture,
    format_summary,
    load_captures,
    measure_capture,
    summarize,
)

CAPTURES = os.path.join(TESTS, "captures")

try:  # Measurement needs the real engine; without it there is nothing to assert.
    import paddleocr  # noqa: F401

    HAVE_PADDLE = True
except Exception:  # pragma: no cover - depends on the host
    HAVE_PADDLE = False


@unittest.skipUnless(HAVE_PADDLE, "PaddleOCR is not installed (pip install -r ocr/requirements.txt)")
class CaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.captures, cls.problems = load_captures(CAPTURES)
        if not cls.captures and not cls.problems:
            raise unittest.SkipTest(
                "no real captures in ocr/tests/captures — drop a RIVALS Tab screenshot "
                "and its <name>.truth.json there to measure them"
            )
        from rivals_ocr.recognize import PaddleTextReader

        cls.reader = PaddleTextReader()
        cls.reader.warmup()

    def test_every_capture_has_a_usable_truth_sidecar(self):
        self.assertEqual(self.problems, [])

    def test_captures_meet_the_accuracy_thresholds(self):
        reports = [measure_capture(capture, self.reader) for capture in self.captures]
        for report in reports:
            for line in format_capture(report):
                print(line)
        summary = summarize(reports, DEFAULT_THRESHOLDS)
        rows = sum(len(report.rows) for report in reports)
        for line in format_summary(summary, len(reports), rows):
            print(line)
        self.assertEqual(summary.failures, [], "real-capture accuracy below threshold")


if __name__ == "__main__":
    unittest.main()
