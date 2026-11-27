"""Entrypoint: `python ocr/serve.py` (run from the repository root)."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rivals_ocr.server import run  # noqa: E402

if __name__ == "__main__":
    run()
