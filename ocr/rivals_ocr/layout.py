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
# The score strip prints its numerals in white; nothing else above the table is
# both that bright and that unsaturated.
SCORE_INK_VALUE = 190
SCORE_INK_SATURATION = 70

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

    @property
    def table(self) -> tuple[int, int, int, int]:
        """The scoreboard's rows only, without the header or the score strip."""
        return (self.panel[0], self.rows[0].y0, self.panel[2], self.rows[-1].y1)


@dataclass
class DamageColumn:
    center: float
    tolerance: float
    confidence: float
    #: x where the damage column ends: nothing right of it is needed.
    right: float | None = None


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
    hsv: np.ndarray, table_top: int, width: int
) -> tuple[int, int, int, int] | None:
    """The strip that holds the two team scores, when the screenshot has one.

    The scores are printed in white and are the largest thing printed above the
    table, so the first band of white text above it is the score strip. Finding
    it by its colour instead does not work on a real 4v4 capture: the map behind
    the HUD is gold there too, and the search swallowed the whole upper screen.
    """
    if table_top < 8:
        return None
    # Only the top of the screen is considered: the strip is right under the
    # minimap, and the table's own header is white text too, but far below.
    limit = max(8, int(round(table_top * 0.4)))
    ink = (
        (hsv[..., 2] >= SCORE_INK_VALUE) & (hsv[..., 1] <= SCORE_INK_SATURATION)
    )[:limit]
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        ink.astype(np.uint8), 8
    )
    boxes = []
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        # A score is a tall, narrow glyph. A bright sky is neither.
        if h < 24 or w < 8 or w > width * 0.15 or area < 200:
            continue
        boxes.append((int(x), int(y), int(x + w), int(y + h)))
    if not boxes:
        return None
    x0 = min(box[0] for box in boxes)
    y0 = min(box[1] for box in boxes)
    x1 = max(box[2] for box in boxes)
    y1 = max(box[3] for box in boxes)
    pad = max(6, int(round((y1 - y0) * 0.2)))
    return (
        max(0, x0 - pad),
        max(0, y0 - pad),
        min(width, x1 + pad),
        min(int(hsv.shape[0]), y1 + pad),
    )


def score_regions(
    gold: np.ndarray, purple: np.ndarray, band: tuple[int, int, int, int] | None, width: int
) -> dict[str, tuple[int, int, int, int]]:
    """Each team's coloured score box, read on its own.

    The two scores sit in boxes of their own team colour, far apart and mixed with
    other HUD numbers: the round timer, coin badges, the level of an avatar. Giving
    each box to the recogniser by itself keeps that clutter out of the crop, which
    is what turned the purple score into a badge on a real 4v4 capture.
    """
    if band is None:
        return {}
    x0, y0, x1, y1 = band
    regions: dict[str, tuple[int, int, int, int]] = {}
    for color, mask in (("gold", gold), ("purple", purple)):
        # A box is at least ~40 px tall; capping the share keeps a plain box
        # found when the band also caught something else, like a bright sky.
        minimum = max(2.0, min((y1 - y0) * 0.2, 25.0))
        columns = mask[y0:y1, x0:x1].sum(axis=0) / 255.0 >= minimum
        xs = np.flatnonzero(columns)
        if xs.size == 0:
            continue
        # A score numeral is drawn over its box, so the box's columns have a hole
        # in them; the gap is bridged here instead of splitting the box in two.
        spans = _column_spans(xs, max(4, int(round(width * 0.04))))
        start, end = max(spans, key=lambda span: span[1] - span[0])
        if end - start < max(12, width * 0.02):
            continue
        pad = max(3, int(round((y1 - y0) * 0.08)))
        regions[color] = (
            max(0, x0 + start - pad),
            max(0, y0 - pad),
            min(width, x0 + end + pad),
            min(int(mask.shape[0]), y1 + pad),
        )
    return regions


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
    bands = _bands(combined, width, height)
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
    # The score strip sits somewhere above the table; everything above the first
    # row is searched, because on a 4v4 capture it floats well down the screen.
    score = _score_hud(hsv, first.y0, width)
    # The header labels sit just above the first row, below the score strip. The
    # row height is only an estimate here (a colour band can hold several rows),
    # so the strip's own bottom is what keeps the header band small.
    header_top = max(0, first.y0 - row_height)
    if score is not None:
        header_top = max(header_top, score[3])
    header = (x0, header_top, x1, first.y0) if first.y0 - header_top >= 8 else None
    if score is None:
        score = (x0, 0, x1, header_top) if header_top >= 8 else None

    return Layout(
        rows=rows,
        panel=(x0, 0, x1, rows[-1].y1),
        header=header,
        score=score,
        row_height=row_height,
    )


#: A final row cut down to less than this share of a normal row is off screen.
CLIPPED_ROW_RATIO = 0.7


def _cluster_centre(lines) -> float:
    return (min(line.box[1] for line in lines) + max(line.box[3] for line in lines)) / 2.0


def _text_clusters(lines) -> list[list]:
    """Groups recognised lines into one cluster per row of text.

    A player row prints the display name above its @handle; those two lines sit a
    couple of pixels apart, while the next player's text starts far below. The gap
    between lines is what separates rows, not the height of any one line.
    """
    tokens = [line for line in lines if line.text.strip()]
    if not tokens:
        return []
    tokens.sort(key=lambda line: (line.box[1] + line.box[3]) / 2.0)
    heights = sorted(max(1.0, line.box[3] - line.box[1]) for line in tokens)
    join = max(4.0, heights[len(heights) // 2] * 0.5)
    clusters: list[list] = []
    for line in tokens:
        if clusters and line.box[1] - max(entry.box[3] for entry in clusters[-1]) <= join:
            clusters[-1].append(line)
        else:
            clusters.append([line])
    return clusters


def _row_pitch(centres: list[float]) -> float | None:
    """The smallest distance between two rows of text: one row's height."""
    gaps = [b - a for a, b in zip(centres, centres[1:]) if b - a >= 12]
    return min(gaps) if gaps else None


def refine_rows(rows: list[Row], lines) -> list[Row]:
    """Splits a row band that holds several players, one row per player.

    Two players on the same team sit on the same colour with no seam between
    them, so their stripes merge into one tall band: a 4v4 board can show four
    gold players as a single block. Their text does not merge, because each
    player has their own name and damage line, so the text decides where one
    player ends and the next begins. A block whose text could not be read is
    split by the row height instead, so an obscured player is still reported
    rather than silently vanishing.
    """
    clusters = _text_clusters(lines)
    centres = [_cluster_centre(cluster) for cluster in clusters]
    pitch = _row_pitch(centres)
    if pitch is None:
        heights = sorted(row.y1 - row.y0 for row in rows)
        pitch = float(heights[len(heights) // 2])
    refined: list[Row] = []
    for row in rows:
        inside = [centre for centre in centres if row.y0 <= centre < row.y1]
        if len(inside) > 1:
            edges = [row.y0]
            edges += [int(round((a + b) / 2.0)) for a, b in zip(inside, inside[1:])]
            edges.append(row.y1)
        else:
            span = row.y1 - row.y0
            parts = max(1, min(int(round(span / max(1.0, pitch))), span // 12))
            step = span / parts
            edges = [int(round(row.y0 + index * step)) for index in range(parts)]
            edges.append(row.y1)
        for top, bottom in zip(edges, edges[1:]):
            if bottom - top < 6:
                continue
            refined.append(
                Row(
                    len(refined),
                    top,
                    bottom,
                    row.x0,
                    row.x1,
                    row.color,
                    row.color_confidence,
                )
            )
    return _drop_clipped(refined)


def _drop_clipped(rows: list[Row]) -> list[Row]:
    """A last row cut off by the bottom of the panel is not fully on screen.

    The list scrolls, so the player at the bottom edge is only half drawn, and
    half of a row is not a result. It is ignored rather than measured or guessed.
    """
    if len(rows) < 2:
        return rows
    heights = sorted(row.y1 - row.y0 for row in rows)
    typical = heights[len(heights) // 2]
    last = rows[-1]
    if last.y1 - last.y0 < typical * CLIPPED_ROW_RATIO:
        return rows[:-1]
    return rows


def damage_column(lines, row_height: int) -> DamageColumn | None:
    """Locates the DMG column from its header label, rejecting EDA and PING."""
    for line in lines:
        key = re.sub(r"[^a-z]", "", line.text.lower())
        if key not in {"dmg", "damage"}:
            continue
        left, _top, right, _bottom = line.box
        center = (left + right) / 2.0
        half = max((right - left) / 2.0, row_height * 0.3)
        # The next column's label marks where damage ends; everything right of it
        # (EDA, PING) is noise for the rows and is left out of their crop.
        boundary = None
        for other in lines:
            other_key = re.sub(r"[^a-z]", "", other.text.lower())
            if other_key not in {"eda", "ping", "kills", "assists"}:
                continue
            if other.box[0] <= right:
                continue
            boundary = other.box[0] if boundary is None else min(boundary, other.box[0])
        return DamageColumn(
            center,
            max(row_height * 0.6, half + 4),
            line.confidence,
            None if boundary is None else boundary - 4,
        )
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

    # The board prints the display name above the player's Roblox @handle. The
    # roster is indexed by the handle, so the @ line is the username when it is
    # printed; the display name is only used for players who have no handle line.
    gap = max(row_height * 0.6, 8)
    handles = [line for line in left if line.text.strip().startswith("@")]
    group = []
    if handles:
        group = _widest_group(handles, gap)
        username = _join(group, prefix="@") or None
    elif left:
        tallest = max(line.box[3] - line.box[1] for line in left)
        primary = [
            line for line in left if (line.box[3] - line.box[1]) >= tallest * 0.75
        ]
        group = _widest_group(primary or left, gap)
        username = _join(group) or None
    else:
        username = None
    username_confidence = (
        sum(line.confidence for line in group) / len(group) if group else 0.0
    )

    return RowText(
        username,
        min(1.0, max(0.0, username_confidence)),
        damage,
        min(1.0, max(0.0, damage_confidence)),
        raw,
        False,
    )


def _widest_group(lines, gap: float) -> list:
    """The widest cluster on the name side: badges and rank columns are narrower."""
    groups = _cluster(lines, gap)
    if not groups:
        return []
    return max(groups, key=lambda group: sum(line.box[2] - line.box[0] for line in group))


def _join(lines, prefix: str = "") -> str:
    """Joins the tokens of one name, spacing them only at a real word gap."""
    parts: list[str] = []
    previous = None
    for line in lines:
        text = line.text.strip()
        if prefix and text.startswith(prefix):
            text = text[len(prefix) :].strip()
        if not text:
            continue
        if previous is not None:
            gap = line.box[0] - previous.box[2]
            height = max(1.0, previous.box[3] - previous.box[1])
            if gap > height * 0.5:
                parts.append(" ")
        parts.append(text)
        previous = line
    return "".join(parts).strip()


def read_score_number(lines, min_height: float = 0.0) -> tuple[int | None, float]:
    """The one score in a team's box: its largest numeral.

    A box can also hold a coin badge, a level or its team-mates' avatars. Those
    are drawn smaller than the score, so the tallest numeral wins; a box with no
    numeral is missing, never zero.
    """
    best: tuple[float, int, float] | None = None
    for line in lines:
        digits = _digits(line.text)
        if digits is None or not SCORE_NUMBER.match(digits):
            continue
        if line.confidence < 0.4:
            continue
        height = line.box[3] - line.box[1]
        if height < min_height:
            continue
        if best is None or (height, line.confidence) > (best[0], best[2]):
            best = (height, int(digits), line.confidence)
    if best is None:
        return None, 0.0
    return best[1], min(1.0, max(0.0, best[2]))

