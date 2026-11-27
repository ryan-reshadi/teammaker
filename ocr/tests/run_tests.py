"""Runs the OCR service's tests: `python ocr/tests/run_tests.py`."""

from __future__ import annotations

import os
import sys
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
OCR = os.path.dirname(TESTS)
sys.path.insert(0, OCR)
sys.path.insert(0, TESTS)

if __name__ == "__main__":
    suite = unittest.TestLoader().discover(TESTS, pattern="test_*.py", top_level_dir=TESTS)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
