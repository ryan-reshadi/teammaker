"""Relative-coordinate geometry for a RIVALS Tab scoreboard.

Rows are found from the team-colour stripes, never from fixed pixels, so any
resolution works. A row's team comes from which colour dominates its stripe.
The DMG column is located from the header text; when the header cannot be read
the damage is reported as missing instead of guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import cv2
import numpy as np

# OpenCV hue is 0-179: gold sits near 21, purple near 130.
GOLD_LOW = np.array([8, 70, 90])
GOLD_HIGH = np.array([38, 255, 255])
PURPLE_LOW = np.array([115, 60, 60])
PURPLE_HIGH = np.array([165, 255, 255])

FULL_NUMBER = re.compile(r"^\d{1,6}$")
SCORE_NUMBER = re.compile(r"^\d{1,3}$")
RANK_NUMBER = re.compile(r"^\d{1,2}$")
# Icons and colour blocks beside a number are often merged into its detection
# ("\u25a15"); non-word noise around the digits is ignored, letters are not.
NUMBER_NOISE = re.compile(r"^[^\w]*([0-9][0-9,\s.]*)[^\w]*$")


class ScoreboardError(Exception):
    """No scoreboard layout was found in the image."""

    code = "scoreboard_not_found"
    status = 422


@dataclass
class Row:
    index: int
    y0: int
    y1: int
    x0: int
    x1: int
    color: str | None
    color_confidence: float


@dataclass
class Layout:
    rows: list[Row]
    panel: tuple[int, int, int, int]
    header: tuple[int, int, int, int] | None
    score: tuple[int, int, int, int] | None
    row_height: int


@dataclass
class DamageColumn:
    center: float
    tolerance: float
    confidence: float


@dataclass
class RowText:
    username: str | None
    username_confidence: float
    damage: int | None
    damage_confidence: float
    raw_damage: str | None
    empty: bool


@dataclass
class ScoreRead:
    gold: int | None
    purple: int | None
    confidence: float
    issue: tuple[str, str] | None


def masks(hsv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    gold = cv2.inRange(hsv, GOLD_LOW, GOLD_HIGH)
    purple = cv2.inRange(hsv, PURPLE_LOW, PURPLE_HIGH)
    kernel = np.ones((3, 3), np.uint8)
    return (
        cv2.morphologyEx(gold, cv2.MORPH_CLOSE, kernel),
        cv2.morphologyEx(purple, cv2.MORPH_CLOSE, kernel),
    )


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(flags):
        if value and start is None:
            start = index
        elif not value and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _merge(runs: list[tuple[int, int]], gap: int) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for y0, y1 in runs:
        if merged and y0 - merged[-1][1] <= gap:
            merged[-1] = (merged[-1][0], y1)
        else:
            merged.append((y0, y1))
    return merged


def _column_spans(columns: np.ndarray, gap: int) -> list[tuple[int, int]]:
    """Groups coloured columns, tolerating gaps of up to `gap` pixels."""
    spans: list[tuple[int, int]] = []
    start: int | None = None
    last = 0
    for value in columns:
        index = int(value)
        if start is None:
            start = last = index
        elif index - last <= gap:
            last = index
        else:
            spans.append((start, last + 1))
            start = last = index
    if start is not None:
        spans.append((start, last + 1))
    return spans


def _bands(combined: np.ndarray, width: int, height: int) -> list[tuple[int, int, int, int]]:
    counts = combined.sum(axis=1) / 255.0
    # A player row is a wide stripe; stray coloured pixels are not.
    flags = counts >= max(6.0, width * 0.12)
    runs = _merge(_runs(flags), max(1, int(round(height * 0.003))))
    bands: list[tuple[int, int, int, int]] = []
    for y0, y1 in runs:
        if y1 - y0 < max(6, int(round(height * 0.010))):
            continue
        band = combined[y0:y1]
        columns = band.sum(axis=0) / 255.0 >= max(2.0, (y1 - y0) * 0.3)
        xs = np.flatnonzero(columns)
        if xs.size == 0:
            continue
        x0, x1 = int(xs[0]), int(xs[-1]) + 1
        if x1 - x0 < width * 0.25:
            continue
        # A player row is one continuous stripe. The HUD score boxes sit on the
        # same line but far apart, so a band made of separated blobs is not a row.
        widest = max(end - start for start, end in _column_spans(xs, max(2, int(round(width * 0.01)))))
        if widest < (x1 - x0) * 0.8:
            continue
        bands.append((y0, y1, x0, x1))
    return bands


def _split_tall(
    bands: list[tuple[int, int, int, int]],
) -> list[tuple[int, int, int, int]]:
    """Rows with no visible gap merge into one band; split by the typical height."""
    if len(bands) < 2:
        return bands
    typical = min(y1 - y0 for y0, y1, _x0, _x1 in bands)
    out: list[tuple[int, int, int, int]] = []
    for y0, y1, x0, x1 in bands:
        span = y1 - y0
        if typical >= 6 and span > typical * 2.4:
            parts = max(2, round(span / typical))
            step = span / parts
            for part in range(parts):
                top = int(round(y0 + part * step))
                bottom = int(round(y0 + (part + 1) * step))
                if bottom - top >= 6:
                    out.append((top, bottom, x0, x1))
        else:
            out.append((y0, y1, x0, x1))
    return out


def _color_runs(
    gold: np.ndarray, purple: np.ndarray, band: tuple[int, int, int, int]
) -> list[tuple[int, int]]:
    """Splits a striped band where the team colour changes.

    Two adjacent rows of different teams share no visible gap, so the colour
    itself is the boundary between them. A band with no clear colour (a row
    painted in both) is not split and stays one unclassified row.
    """
    y0, y1, x0, x1 = band
    gold_counts = gold[y0:y1, x0:x1].sum(axis=1) / 255.0
    purple_counts = purple[y0:y1, x0:x1].sum(axis=1) / 255.0
    join_gap = max(2, int(round((y1 - y0) * 0.04)))
    runs: list[list[int]] = []
    for offset, (gold_count, purple_count) in enumerate(zip(gold_counts, purple_counts)):
        if gold_count > 0 and gold_count >= purple_count * 1.6:
            label = 0
        elif purple_count > 0 and purple_count >= gold_count * 1.6:
            label = 1
        else:
            continue
        top = y0 + offset
        if runs and runs[-1][2] == label and top - runs[-1][1] <= join_gap:
            runs[-1][1] = top + 1
        else:
            runs.append([top, top + 1, label])
    return [(start, end) for start, end, _label in runs if end - start >= 6]


def _score_hud(
    gold: np.ndarray, purple: np.ndarray, table_top: int, width: int
) -> tuple[int, int, int, int] | None:
    """The coloured score strip above the table, when the screenshot has one.

    The game puts the two team scores in coloured boxes at the top of the screen,
    far from the table and mixed with other HUD numbers (the timer, coin badges).
    Reading those boxes on their own keeps that clutter out of the score crop.
    """
    if table_top < 8:
        return None
    combined = cv2.bitwise_or(gold[:table_top], purple[:table_top])
    counts = combined.sum(axis=1) / 255.0
    runs = _merge(_runs(counts >= max(6.0, width * 0.06)), max(1, int(round(table_top * 0.02))))
    best: tuple[int, tuple[int, int, int, int]] | None = None
    for y0, y1 in runs:
        if y1 - y0 < max(8, int(round(table_top * 0.04))):
            continue
        columns = combined[y0:y1].sum(axis=0) / 255.0 >= max(2.0, (y1 - y0) * 0.2)
        xs = np.flatnonzero(columns)
        if xs.size == 0:
            continue
        box = (int(xs[0]), y0, int(xs[-1]) + 1, y1)
        area = (box[2] - box[0]) * (box[3] - box[1])
        if best is None or area > best[0]:
            best = (area, box)
    if best is None:
        return None
    x0, y0, x1, y1 = best[1]
    pad = max(4, int(round((y1 - y0) * 0.15)))
    return (
        max(0, x0 - pad),
        max(0, y0 - pad),
        min(width, x1 + pad),
        min(int(gold.shape[0]), y1 + pad),
    )


def _classify(
    gold: np.ndarray, purple: np.ndarray, y0: int, y1: int, x0: int, x1: int
) -> tuple[str | None, float]:
    area = max(1, (y1 - y0) * (x1 - x0))
    gold_count = float(gold[y0:y1, x0:x1].sum()) / 255.0
    purple_count = float(purple[y0:y1, x0:x1].sum()) / 255.0
    total = gold_count + purple_count
    if total < area * 0.08:
        return None, 0.0
    if gold_count >= purple_count * 1.6:
        return "gold", gold_count / total
    if purple_count >= gold_count * 1.6:
        return "purple", purple_count / total
    return None, max(gold_count, purple_count) / total


def analyze(hsv: np.ndarray) -> Layout:
    height, width = hsv.shape[:2]
    gold, purple = masks(hsv)
    combined = cv2.bitwise_or(gold, purple)
    bands = _split_tall(_bands(combined, width, height))
    if not bands:
        raise ScoreboardError("No RIVALS scoreboard was found in that screenshot.")

    rows: list[Row] = []
    for y0, y1, x0, x1 in bands:
        for run_y0, run_y1 in _color_runs(gold, purple, (y0, y1, x0, x1)) or [(y0, y1)]:
            color, confidence = _classify(gold, purple, run_y0, run_y1, x0, x1)
            rows.append(Row(len(rows), run_y0, run_y1, x0, x1, color, confidence))

    # Every row crop starts at the same x, so the DMG column located in the
    # header lines up with the numbers in a row crop.
    x0 = min(row.x0 for row in rows)
    x1 = max(row.x1 for row in rows)
    for row in rows:
        row.x0, row.x1 = x0, x1

    heights = sorted(row.y1 - row.y0 for row in rows)
    row_height = max(1, int(round(heights[len(heights) // 2])))

    first = rows[0]
    header_top = max(0, first.y0 - row_height)
    header = (x0, header_top, x1, first.y0) if first.y0 - header_top >= 8 else None
    # The score HUD sits above the header, sometimes at the very top of the
    # screenshot; without a coloured strip there, everything above the table is
    # all the room the scores have.
    score_top = header[1] if header else header_top
    score = _score_hud(gold, purple, score_top, width)
    if score is None:
        score = (x0, 0, x1, score_top) if score_top >= 8 else None

    return Layout(
        rows=rows,
        panel=(x0, 0, x1, rows[-1].y1),
        header=header,
        score=score,
        row_height=row_height,
    )


def damage_column(lines, row_height: int) -> DamageColumn | None:
    """Locates the DMG column from its header label, rejecting EDA and PING."""
    for line in lines:
        key = re.sub(r"[^a-z]", "", line.text.lower())
        if key not in {"dmg", "damage"}:
            continue
        left, _top, right, _bottom = line.box
        center = (left + right) / 2.0
        half = max((right - left) / 2.0, row_height * 0.3)
        return DamageColumn(center, max(row_height * 0.6, half + 4), line.confidence)
    return None


def _digits(text: str) -> str | None:
    match = NUMBER_NOISE.match(text.strip())
    if not match:
        return None
    return re.sub(r"[,\s.]", "", match.group(1))


def _clean_number(text: str) -> int | None:
    compact = _digits(text)
    return int(compact) if compact and FULL_NUMBER.match(compact) else None


def _cluster(tokens, gap: float):
    ordered = sorted(tokens, key=lambda line: line.box[0])
    groups: list[list] = []
    for line in ordered:
        if groups and line.box[0] - groups[-1][-1].box[2] <= gap:
            groups[-1].append(line)
        else:
            groups.append([line])
    return groups


def parse_row(lines, column: DamageColumn | None, row_height: int) -> RowText:
    tokens = [line for line in lines if line.text.strip()]
    if not tokens:
        return RowText(None, 0.0, None, 0.0, None, True)

    damage: int | None = None
    raw: str | None = None
    damage_confidence = 0.0
    if column is not None:
        candidates: list[tuple[float, int, str]] = []
        for line in tokens:
            value = _clean_number(line.text)
            if value is None:
                continue
            center = (line.box[0] + line.box[2]) / 2.0
            if abs(center - column.center) <= column.tolerance:
                candidates.append((line.confidence, value, line.text.strip()))
        if candidates:
            candidates.sort(key=lambda entry: entry[0], reverse=True)
            damage_confidence, damage, raw = candidates[0]

    # Usernames sit left of the damage column. A rank column is a short integer.
    limit = column.center - column.tolerance * 0.5 if column else float("inf")
    left = [
        line
        for line in tokens
        if (line.box[0] + line.box[2]) / 2.0 < limit
        and not RANK_NUMBER.match(line.text.strip())
    ]
    if not left:
        left = [line for line in tokens if _clean_number(line.text) is None]

    # The board prints the display name above an @handle. The name is the
    # username; the smaller handle line is dropped rather than concatenated.
    named = [line for line in left if not line.text.strip().startswith("@")]
    left = named or left

    username: str | None = None
    username_confidence = 0.0
    if left:
        tallest = max(line.box[3] - line.box[1] for line in left)
        primary = [
            line for line in left if (line.box[3] - line.box[1]) >= tallest * 0.75
        ]
        group = _cluster(primary or left, max(row_height * 0.6, 8))[-1]
        username = _join(group) or None
        username_confidence = sum(line.confidence for line in group) / len(group)

    return RowText(
        username,
        min(1.0, max(0.0, username_confidence)),
        damage,
        min(1.0, max(0.0, damage_confidence)),
        raw,
        False,
    )


def _join(lines) -> str:
    """Joins the tokens of one name, spacing them only at a real word gap."""
    parts: list[str] = []
    previous = None
    for line in lines:
        if previous is not None:
            gap = line.box[0] - previous.box[2]
            height = max(1.0, previous.box[3] - previous.box[1])
            if gap > height * 0.5:
                parts.append(" ")
        parts.append(line.text.strip())
        previous = line
    return "".join(parts).strip()


def _mask_center(mask: np.ndarray) -> float | None:
    columns = np.flatnonzero((mask.sum(axis=0) / 255.0) >= 2)
    if columns.size == 0:
        return None
    return float(columns.mean())


def _line_center(line) -> float:
    return (line.box[0] + line.box[2]) / 2.0


def parse_scores(
    lines, gold_mask: np.ndarray, purple_mask: np.ndarray
) -> ScoreRead:
    numbers: list[tuple[object, int, float]] = []
    for line in lines:
        digits = _digits(line.text)
        if digits is None or not SCORE_NUMBER.match(digits):
            continue
        if line.confidence < 0.4:
            continue
        numbers.append((line, int(digits), line.box[3] - line.box[1]))
    if not numbers:
        return ScoreRead(
            None,
            None,
            0.0,
            (
                "score_ambiguous",
                "The two team scores could not be read — choose the winner by hand.",
            ),
        )
    gold_center = _mask_center(gold_mask)
    purple_center = _mask_center(purple_mask)
    if gold_center is None or purple_center is None:
        return ScoreRead(
            None,
            None,
            0.0,
            (
                "score_ambiguous",
                "The team colours could not be matched to the scores — choose the winner by hand.",
            ),
        )

    def pick(center: float, other: float):
        nearest = [
            entry
            for entry in numbers
            if abs(_line_center(entry[0]) - center) <= abs(_line_center(entry[0]) - other)
        ]
        if not nearest:
            return None
        # The score is the large numeral in a team's colour; a small badge in the
        # same box (a coin count) is lower and would otherwise win on proximity.
        nearest.sort(key=lambda entry: (entry[2], entry[0].confidence), reverse=True)
        return nearest[0]

    gold_entry = pick(gold_center, purple_center)
    purple_entry = pick(purple_center, gold_center)
    if gold_entry is None or purple_entry is None or gold_entry[0] is purple_entry[0]:
        return ScoreRead(
            None,
            None,
            0.0,
            (
                "score_ambiguous",
                "Each score could not be tied to a team — choose the winner by hand.",
            ),
        )
    confidence = (gold_entry[0].confidence + purple_entry[0].confidence) / 2.0
    return ScoreRead(
        gold_entry[1], purple_entry[1], min(1.0, max(0.0, confidence)), None
    )
