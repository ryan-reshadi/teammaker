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
    parse_scores,
)

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


#: The score strip is small and each numeral sits beside an avatar and a coin
#: badge; rendered at 2x the two are separate detections, at 1x the numeral can
#: merge into the avatar and be lost.
SCORE_UPSCALE = 2


def _read_scores(box, reader, image: np.ndarray, gold: np.ndarray, purple: np.ndarray):
    region = crop(image, box)
    gold_region = crop(gold, box)
    purple_region = crop(purple, box)
    if SCORE_UPSCALE != 1 and region.size:
        region = cv2.resize(
            region, None, fx=SCORE_UPSCALE, fy=SCORE_UPSCALE, interpolation=cv2.INTER_CUBIC
        )
        gold_region = cv2.resize(
            gold_region, None, fx=SCORE_UPSCALE, fy=SCORE_UPSCALE, interpolation=cv2.INTER_NEAREST
        )
        purple_region = cv2.resize(
            purple_region,
            None,
            fx=SCORE_UPSCALE,
            fy=SCORE_UPSCALE,
            interpolation=cv2.INTER_NEAREST,
        )
    return parse_scores(
        reader.read(region, "score"), gold_region, purple_region
    )


def analyze_image(image: np.ndarray, reader) -> dict:
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    # 1. Layout: rows from team colours, header and score bands above them.
    layout = analyze(hsv)
    gold, purple = masks(hsv)
    issues: list[dict] = []

    # 2. The DMG column, from its header label only.
    column = None
    if layout.header is not None:
        header_lines = reader.read(crop(image, layout.header), "header")
        column = damage_column(header_lines, layout.row_height)
    if column is None:
        issues.append(
            _issue(
                "header_unreadable",
                "The DMG column header could not be read, so damage is left blank.",
                field="damage",
            )
        )

    # 3. Per row: username, damage and the team its stripe belongs to.
    rows: list[dict] = []
    for row in layout.rows:
        lines = reader.read(
            crop(image, (row.x0, row.y0, row.x1, row.y1)), f"row:{row.index}"
        )
        text = parse_row(lines, column, layout.row_height)
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

    # 4. Team scores and the winner. A tie or a missing score is never guessed.
    if layout.score is None:
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
        scores = _read_scores(layout.score, reader, image, gold, purple)
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
