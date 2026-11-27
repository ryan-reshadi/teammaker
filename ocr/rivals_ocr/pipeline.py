"""Runs the extraction stages in order and returns one structured document."""

from __future__ import annotations

import cv2
import numpy as np

from .imaging import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_DIMENSION,
    crop,
    decode,
)
from .layout import (
    ScoreRead,
    analyze,
    damage_column,
    masks,
    parse_row,
    read_score_number,
    refine_rows,
    score_regions,
)
from .recognize import TextLine

SCAN_VERSION = 1


def _issue(code, message, row_index=None, field=None):
    issue = {"code": code, "message": message}
    if row_index is not None:
        issue["rowIndex"] = row_index
    if field is not None:
        issue["field"] = field
    return issue


def scan_image(
    data: bytes,
    reader,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
) -> dict:
    """Validates and decodes an upload, then extracts the scoreboard."""
    image = decode(data, max_bytes, max_dimension)
    return analyze_image(image, reader)


#: The score is a large glyph next to small ones, so it is read at 4x from a
#: crop that holds little else; a numeral against a crop edge is not recognised.
SCORE_UPSCALE = 4
SCORE_FACE = 0.35
SCORE_MIN_WIDTH = 80
#: A score stands about half the box tall. Anything shorter is a coin badge.
SCORE_MIN_HEIGHT = 0.4


def _offset(lines, box) -> list:
    """Moves crop-relative text boxes into image coordinates."""
    x0, y0, _x1, _y1 = box
    return [
        TextLine(
            line.text,
            line.confidence,
            (line.box[0] + x0, line.box[1] + y0, line.box[2] + x0, line.box[3] + y0),
        )
        for line in lines
    ]


def _centre_y(line) -> float:
    return (line.box[1] + line.box[3]) / 2.0


def _score_facing(box, width: int) -> tuple[int, int, int, int]:
    """The end of a score box that faces the timer, where the score is drawn.

    The two boxes sit either side of the timer and each score is drawn against
    the timer, so the rest of a box holds avatars, coin badges and a level bar
    that the recogniser can mistake for a score.
    """
    x0, y0, x1, y1 = box
    span = x1 - x0
    part = min(span, max(SCORE_MIN_WIDTH, int(round(span * SCORE_FACE))))
    if (x0 + x1) / 2 < width / 2:
        return (x1 - part, y0, x1, y1)
    return (x0, y0, x0 + part, y1)


def _read_score_crop(color: str, box, reader, image: np.ndarray, minimum: float = 0.0):
    region = crop(image, box)
    if region.size == 0:
        return None, 0.0
    region = cv2.resize(
        region,
        None,
        fx=SCORE_UPSCALE,
        fy=SCORE_UPSCALE,
        interpolation=cv2.INTER_CUBIC,
    )
    return read_score_number(
        reader.read(region, f"score:{color}", box), minimum * SCORE_UPSCALE
    )


def _read_score(color: str, box, reader, image: np.ndarray):
    """A team's score, read where it is drawn and never from a badge."""
    value, confidence = _read_score_crop(
        color, _score_facing(box, int(image.shape[1])), reader, image
    )
    if value is not None:
        return value, confidence
    # Second look at the whole box, still refusing anything smaller than a score.
    minimum = (box[3] - box[1]) * SCORE_MIN_HEIGHT
    return _read_score_crop(color, box, reader, image, minimum)


def _read_scores(reader, image: np.ndarray, regions) -> ScoreRead:
    """Reads each team's own score box. A score that is not there stays missing."""
    scores: dict[str, int | None] = {"gold": None, "purple": None}
    confidences: list[float] = []
    for color in ("gold", "purple"):
        box = regions.get(color)
        if box is None:
            continue
        value, confidence = _read_score(color, box, reader, image)
        scores[color] = value
        if value is not None:
            confidences.append(confidence)
    if scores["gold"] is None or scores["purple"] is None:
        return ScoreRead(
            None,
            None,
            0.0,
            (
                "score_ambiguous",
                "The two team scores could not both be read — choose the winner by hand.",
            ),
        )
    confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return ScoreRead(scores["gold"], scores["purple"], confidence, None)


def analyze_image(image: np.ndarray, reader) -> dict:
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    # 1. Layout: rows from team colours, header and score bands above them.
    layout = analyze(hsv)
    gold, purple = masks(hsv)
    issues: list[dict] = []

    # 2. The DMG column, from its header label only. It also marks where the
    # names and damage end: EDA and PING are not needed, and every extra line the
    # recogniser has to read costs a noticeable amount of time.
    column = None
    if layout.header is not None:
        header_lines = _offset(
            reader.read(crop(image, layout.header), "header", layout.header),
            layout.header,
        )
        column = damage_column(header_lines, layout.row_height)
    if column is None:
        issues.append(
            _issue(
                "header_unreadable",
                "The DMG column header could not be read, so damage is left blank.",
                field="damage",
            )
        )

    # 3. One pass over the table's text. The team stripes cannot separate two
    # players of the same team, but their names and damage lines can, so the
    # text decides how many players a colour band holds.
    table = layout.table
    if column is not None and column.right is not None:
        table = (table[0], table[1], max(table[0] + 40, int(column.right)), table[3])
    table_lines = _offset(reader.read(crop(image, table), "table", table), table)
    table_rows = refine_rows(layout.rows, table_lines) if table_lines else layout.rows
    heights = sorted(row.y1 - row.y0 for row in table_rows)
    row_height = max(1, int(round(heights[len(heights) // 2])))

    # 4. Per row: username, damage and the team its stripe belongs to.
    rows: list[dict] = []
    for row in table_rows:
        if table_lines:
            lines = [
                line for line in table_lines if row.y0 <= _centre_y(line) < row.y1
            ]
        else:
            # Nothing was recognised in the table crop; try each row on its own.
            box = (row.x0, row.y0, row.x1, row.y1)
            lines = _offset(
                reader.read(crop(image, box), f"row:{row.index}", box), box
            )
        text = parse_row(lines, column, row_height)
        row_issues: list[dict] = []
        if text.empty:
            row_issues.append(
                _issue(
                    "row_obscured",
                    "This row could not be read at all — check it or remove it.",
                    row.index,
                )
            )
        if row.color is None:
            row_issues.append(
                _issue(
                    "team_ambiguous",
                    "The team colour of this row is unclear — choose the team.",
                    row.index,
                    "team",
                )
            )
        if text.username is None:
            row_issues.append(
                _issue(
                    "username_unreadable",
                    "No username was read — type it or remove the row.",
                    row.index,
                    "username",
                )
            )
        elif text.username_confidence < 0.7:
            row_issues.append(
                _issue(
                    "low_confidence",
                    "Low confidence username — check the spelling.",
                    row.index,
                    "username",
                )
            )
        if text.damage is None:
            row_issues.append(
                _issue(
                    "damage_unreadable",
                    "Damage could not be read — enter it by hand.",
                    row.index,
                    "damage",
                )
            )
        issues.extend(row_issues)
        rows.append(
            {
                "index": row.index,
                "teamSlot": (
                    0 if row.color == "gold" else 1 if row.color == "purple" else None
                ),
                "color": row.color,
                "username": text.username,
                "usernameConfidence": round(text.username_confidence, 3),
                "damage": text.damage,
                "damageConfidence": round(text.damage_confidence, 3),
                "rawDamageText": text.raw_damage,
                "issues": row_issues,
            }
        )

    # 5. Team scores and the winner. A tie or a missing score is never guessed.
    regions = score_regions(gold, purple, layout.score, width)
    if not regions:
        scores = ScoreRead(
            None,
            None,
            0.0,
            (
                "score_ambiguous",
                "The team scores are not visible — choose the winner by hand.",
            ),
        )
    else:
        scores = _read_scores(reader, image, regions)
    if scores.issue is not None:
        issues.append(_issue(scores.issue[0], scores.issue[1], field="score"))

    winner = None
    if scores.gold is not None and scores.purple is not None:
        if scores.gold == scores.purple:
            issues.append(
                _issue(
                    "score_ambiguous",
                    "The scores are tied — confirm the winning team.",
                    field="score",
                )
            )
        else:
            winner = 0 if scores.gold > scores.purple else 1

    return {
        "version": SCAN_VERSION,
        "image": {"width": int(width), "height": int(height)},
        "teams": [
            {
                "slot": 0,
                "color": "gold",
                "score": scores.gold,
                "confidence": round(scores.confidence, 3),
            },
            {
                "slot": 1,
                "color": "purple",
                "score": scores.purple,
                "confidence": round(scores.confidence, 3),
            },
        ],
        "winnerSlot": winner,
        "rows": rows,
        "issues": issues,
    }
