"""Measures the real pipeline against real RIVALS screenshots.

    python ocr/tools/measure_captures.py                 # from anywhere
    bun run ocr:captures

Prints one block per capture (expected vs read, row by row), the accuracy totals
and a PASS/FAIL verdict against the thresholds. Exits 1 when a capture fails,
when a capture has no truth sidecar, or when the directory holds images that
cannot be read; exits 0 with a clear message when there are no captures at all,
because an empty directory is "not measured yet", not a failing measurement.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from rivals_ocr.captures import (  # noqa: E402
    DEFAULT_THRESHOLDS,
    format_capture,
    format_summary,
    load_captures,
    measure_capture,
    summarize,
)

DEFAULT_DIR = os.path.join(ROOT, "tests", "captures")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure the RIVALS scoreboard pipeline against real screenshots."
    )
    parser.add_argument(
        "--dir",
        default=DEFAULT_DIR,
        help=f"capture directory (default: {os.path.relpath(DEFAULT_DIR)})",
    )
    for name, default in DEFAULT_THRESHOLDS.items():
        parser.add_argument(
            f"--min-{name}",
            type=float,
            default=default,
            help=f"minimum {name} accuracy, 0..1 (default: {default:.0%})",
        )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print a machine-readable summary instead of the report",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    thresholds = {
        name: getattr(args, f"min_{name}") for name in DEFAULT_THRESHOLDS
    }
    directory = os.path.abspath(args.dir)

    captures, problems = load_captures(directory)
    if problems:
        print("Unusable captures:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    if not captures:
        print(f"No captures found in {directory}.")
        print(
            "Drop a RIVALS Tab scoreboard screenshot there with its <name>.truth.json "
            "sidecar to measure real accuracy; see ocr/tests/captures/README.md."
        )
        return 0

    from rivals_ocr.recognize import EngineUnavailable, PaddleTextReader

    reader = PaddleTextReader()
    try:
        reader.warmup()
    except EngineUnavailable as error:
        print(f"Cannot measure: {error}", file=sys.stderr)
        print(
            "Install the service's dependencies first: "
            "ocr/.venv/Scripts/python.exe -m pip install -r ocr/requirements.txt",
            file=sys.stderr,
        )
        return 2

    reports = []
    for index, capture in enumerate(captures, start=1):
        print(f"[{index}/{len(captures)}] measuring {capture.name}", flush=True)
        report = measure_capture(capture, reader)
        reports.append(report)
        for line in format_capture(report):
            print(line)
        print()

    summary = summarize(reports, thresholds)
    rows = sum(len(report.rows) for report in reports)
    for line in format_summary(summary, len(reports), rows):
        print(line)

    if args.json:
        print(
            json.dumps(
                {
                    "captures": len(reports),
                    "rows": rows,
                    "accuracy": {
                        name: {
                            "correct": correct,
                            "total": total,
                            "ratio": (1.0 if total == 0 else correct / total),
                            "min": thresholds.get(name, 1.0),
                        }
                        for name, (correct, total) in summary.counts.items()
                    },
                    "failures": summary.failures,
                    "passed": summary.passed,
                },
                indent=2,
            )
        )

    return 0 if summary.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
