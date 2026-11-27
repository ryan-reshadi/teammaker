"""Measurement of the pipeline against real RIVALS screenshots.

A *capture* is a screenshot plus a sidecar `.truth.json` holding what the
screenshot really says. `measure_capture` runs the production pipeline (real
PaddleOCR, real geometry) over the capture and compares field by field, and
`summarize` turns those comparisons into the accuracy numbers the README quotes.

Nothing here is used at runtime; the service never reads this module's directory.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from .imaging import decode
from .pipeline import analyze_image

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")
TRUTH_SUFFIX = ".truth.json"

#: A real screenshot is held to exact matches: a plausible-but-wrong value is
#: worse than a blank one, because the review screen only asks about blanks.
DEFAULT_THRESHOLDS = {
    "username": 1.0,
    "damage": 1.0,
    "team": 1.0,
    "score": 1.0,
    "winner": 1.0,
}

TEAM_SLOT = {"gold": 0, "purple": 1}


@dataclass
class Capture:
    name: str
    image_path: str
    truth: dict

    @property
    def truth_path(self) -> str:
        return _truth_path(self.image_path)


@dataclass
class RowCheck:
    index: int
    expected: dict
    actual: dict
    checks: dict[str, bool | None] = field(default_factory=dict)

    @property
    def issues(self) -> list[str]:
        return [issue["code"] for issue in self.actual.get("issues", [])]


@dataclass
class CaptureReport:
    capture: Capture
    size: tuple[int, int]
    rows: list[RowCheck]
    checks: dict[str, bool | None]
    issues: list[str]
    seconds: float
    error: str | None = None
    #: The document the pipeline produced, so the report can show what it read.
    result: dict = field(default_factory=dict)
    #: How many rows the pipeline segmented, which can differ from the truth.
    read_rows: int = 0


@dataclass
class Summary:
    """Per-field accuracy across every capture."""

    counts: dict[str, tuple[int, int]]
    failures: list[str]
    thresholds: dict[str, float]

    @property
    def passed(self) -> bool:
        return not self.failures

    def accuracy(self, name: str) -> float:
        correct, total = self.counts.get(name, (0, 0))
        return 1.0 if total == 0 else correct / total


def _truth_path(image_path: str) -> str:
    stem, _suffix = os.path.splitext(image_path)
    return stem + TRUTH_SUFFIX


def _capture_names(directory: str) -> list[str]:
    if not os.path.isdir(directory):
        return []
    names = []
    for entry in sorted(os.listdir(directory)):
        path = os.path.join(directory, entry)
        if not os.path.isfile(path):
            continue
        if entry.lower().endswith(IMAGE_SUFFIXES):
            names.append(path)
    return names


def load_captures(directory: str) -> tuple[list[Capture], list[str]]:
    """Returns the usable captures and one message per unusable one."""
    captures: list[Capture] = []
    problems: list[str] = []
    for image_path in _capture_names(directory):
        truth_path = _truth_path(image_path)
        name = os.path.basename(image_path)
        if not os.path.isfile(truth_path):
            problems.append(
                f"{name}: missing {os.path.basename(truth_path)} "
                "(see ocr/tests/captures/README.md for the format)"
            )
            continue
        try:
            with open(truth_path, "r", encoding="utf-8") as handle:
                truth = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            problems.append(f"{name}: {os.path.basename(truth_path)} is not valid JSON ({error})")
            continue
        if not isinstance(truth, dict) or not isinstance(truth.get("rows"), list):
            problems.append(
                f"{name}: {os.path.basename(truth_path)} must be an object with a rows array"
            )
            continue
        captures.append(Capture(name, image_path, truth))
    return captures, problems


def apply_transform(image: np.ndarray, transform: dict | None) -> np.ndarray:
    """Optional per-capture post-processing: crop, then scale, then rotate.

    It exists for captures that are wider or smaller than the game window; a
    plain screenshot needs no transform at all.
    """
    if not transform:
        return image
    if not isinstance(transform, dict):
        raise ValueError("transform must be an object")
    box = transform.get("crop")
    if box is not None:
        if not (isinstance(box, list) and len(box) == 4):
            raise ValueError("transform.crop must be [x, y, width, height]")
        x, y, width, height = (int(value) for value in box)
        height_in, width_in = image.shape[:2]
        if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > width_in or y + height > height_in:
            raise ValueError("transform.crop is outside the image")
        image = image[y : y + height, x : x + width]
    scale = float(transform.get("scale", 1.0))
    if scale != 1.0:
        if scale <= 0:
            raise ValueError("transform.scale must be positive")
        interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=interpolation)
    rotate = int(transform.get("rotate", 0)) % 360
    if rotate == 90:
        image = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    elif rotate == 180:
        image = cv2.rotate(image, cv2.ROTATE_180)
    elif rotate == 270:
        image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    elif rotate != 0:
        raise ValueError("transform.rotate must be 0, 90, 180 or 270")
    return image


def _same_username(expected, actual) -> bool:
    if expected is None:
        return actual is None
    return actual is not None and actual == expected


def _expected_team(row: dict) -> str | None:
    team = row.get("team")
    return team if team in TEAM_SLOT else None


def _actual_winner(result: dict) -> str | None:
    slot = result.get("winnerSlot")
    if slot is None:
        return None
    for team in result.get("teams", []):
        if team.get("slot") == slot:
            return team.get("color")
    return None


def measure_capture(capture: Capture, reader) -> CaptureReport:
    started = time.time()
    try:
        with open(capture.image_path, "rb") as handle:
            data = handle.read()
        image = decode(data)
        image = apply_transform(image, capture.truth.get("transform"))
        result = analyze_image(image, reader)
    except Exception as error:  # noqa: BLE001 - reported, never raised at the CLI
        return CaptureReport(
            capture,
            (0, 0),
            [],
            {},
            [],
            time.time() - started,
            error=f"{type(error).__name__}: {error}",
        )

    height, width = image.shape[:2]
    expected_rows = capture.truth.get("rows", [])
    actual_rows = result.get("rows", [])
    rows: list[RowCheck] = []
    for index, expected in enumerate(expected_rows):
        actual = actual_rows[index] if index < len(actual_rows) else {}
        checks: dict[str, bool | None] = {}
        if "username" in expected:
            checks["username"] = _same_username(expected["username"], actual.get("username"))
        if "damage" in expected:
            checks["damage"] = actual.get("damage") == expected["damage"]
        if "team" in expected:
            checks["team"] = actual.get("color") == _expected_team(expected)
        rows.append(RowCheck(index, expected, actual, checks))

    expected_teams = capture.truth.get("teams") or {}
    read_teams = {team.get("color"): team.get("score") for team in result.get("teams", [])}
    checks = {}
    score_ok: list[bool] = []
    for color in ("gold", "purple"):
        if color in expected_teams:
            ok = read_teams.get(color) == expected_teams[color]
            checks[f"{color}Score"] = ok
            score_ok.append(ok)
    if "winner" in capture.truth:
        checks["winner"] = _actual_winner(result) == capture.truth["winner"]
    if score_ok:
        checks["score"] = all(score_ok)

    return CaptureReport(
        capture,
        (width, height),
        rows,
        checks,
        [issue["code"] for issue in result.get("issues", [])],
        time.time() - started,
        result=result,
        read_rows=len(actual_rows),
    )


def summarize(
    reports: list[CaptureReport], thresholds: dict[str, float] | None = None
) -> Summary:
    limits = dict(DEFAULT_THRESHOLDS)
    limits.update(thresholds or {})
    counts: dict[str, list[int]] = {}
    failures: list[str] = []

    def record(name: str, ok: bool) -> None:
        bucket = counts.setdefault(name, [0, 0])
        bucket[1] += 1
        if ok:
            bucket[0] += 1

    # Both team scores count towards one `score` metric, so a wrong gold score is
    # not reported twice under two names.
    aliases = {"goldScore": "score", "purpleScore": "score"}

    for report in reports:
        if report.error:
            failures.append(f"{report.capture.name}: {report.error}")
            continue
        for row in report.rows:
            for name, ok in row.checks.items():
                if ok is not None:
                    record(name, ok)
        for name, ok in report.checks.items():
            if ok is not None:
                record(aliases.get(name, name), ok)

    for name, (correct, total) in counts.items():
        if total == 0:
            continue
        limit = limits.get(name, 1.0)
        if correct / total < limit:
            failures.append(
                f"{name}: {correct}/{total} ({correct / total:.1%}) below {limit:.0%}"
            )
    return Summary(
        {name: (value[0], value[1]) for name, value in counts.items()},
        failures,
        limits,
    )


def _value(value) -> str:
    if value is None:
        return "-"
    if isinstance(value, str) and not value:
        return "''"
    return str(value)


def format_capture(report: CaptureReport) -> list[str]:
    width, height = report.size
    header = f"[{report.capture.name}] {width}x{height} in {report.seconds:.1f}s"
    if report.error:
        return [header, f"  FAILED: {report.error}"]
    lines = [header]

    def mark(ok: bool | None) -> str:
        return "" if ok is None else ("ok" if ok else "MISMATCH")

    for row in report.rows:
        actual = row.actual
        row_header = f"  row {row.index}"
        if "username" in row.checks:
            lines.append(
                f"{row_header}  username  expected {_value(row.expected.get('username'))!r:24}"
                f" read {_value(actual.get('username'))!r:24} {mark(row.checks['username'])}"
            )
        if "damage" in row.checks:
            lines.append(
                f"{row_header}  damage    expected {_value(row.expected.get('damage')):12}"
                f" read {_value(actual.get('damage')):12} {mark(row.checks['damage'])}"
            )
        if "team" in row.checks:
            lines.append(
                f"{row_header}  team      expected {_value(row.expected.get('team')):12}"
                f" read {_value(actual.get('color')):12} {mark(row.checks['team'])}"
            )
        if row.issues:
            lines.append(f"{row_header}  issues    {', '.join(row.issues)}")
    expected_rows = len(report.capture.truth.get("rows", []))
    if report.read_rows != expected_rows:
        lines.append(f"  rows: read {report.read_rows} of {expected_rows}")
    scores = {team.get("color"): team.get("score") for team in report.result.get("teams", [])}
    for name in ("goldScore", "purpleScore", "winner"):
        if name not in report.checks:
            continue
        if name.endswith("Score"):
            color = name[: -len("Score")]
            expected = report.capture.truth.get("teams", {}).get(color)
            actual = scores.get(color)
        else:
            expected = report.capture.truth.get("winner")
            actual = _actual_winner(report.result)
        lines.append(
            f"  {name:9} expected {_value(expected):12} read {_value(actual):12}"
            f" {mark(report.checks[name])}"
        )
    if report.issues:
        lines.append(f"  document issues: {', '.join(report.issues)}")
    return lines


def format_summary(summary: Summary, captures: int, rows: int) -> list[str]:
    lines = [f"Accuracy across {captures} capture(s) and {rows} row(s):"]
    order = ("username", "damage", "team", "score", "winner")
    for name in order:
        correct, total = summary.counts.get(name, (0, 0))
        if total == 0:
            lines.append(f"  {name:9} not checked (no truth)")
            continue
        limit = summary.thresholds.get(name, 1.0)
        state = "PASS" if correct / total >= limit else "FAIL"
        lines.append(
            f"  {name:9} {correct}/{total}  {correct / total:6.1%}  (min {limit:.0%})  {state}"
        )
    for failure in summary.failures:
        lines.append(f"  ! {failure}")
    lines.append("RESULT: PASS" if summary.passed else "RESULT: FAIL")
    return lines
