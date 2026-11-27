"""Synthetic RIVALS scoreboards for pipeline tests.

These images are generated, not captured. They exercise geometry, colour
classification and parsing deterministically; they are not evidence of accuracy
on real in-game screenshots.
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

WIDTH = 1280
HEIGHT = 760
PANEL_X0, PANEL_X1 = 240, 1040
ROW_HEIGHT = 56
ROW_GAP = 4
TEAM_GAP = 18
FIRST_ROW_Y = 220
HEADER_TOP = FIRST_ROW_Y - ROW_HEIGHT
SCORE_TOP = HEADER_TOP - 140
DMG_CENTER = PANEL_X1 - 170
SCORE_GOLD_X = 330
SCORE_PURPLE_X = 830
SCORE_BOX = 34
GOLD = (214, 168, 58)
PURPLE = (124, 74, 214)
INK = (248, 246, 240)
PANEL_BG = (26, 23, 31)


def _font(size: int = 26):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _frac(x: float) -> float:
    return (x - PANEL_X0) / (PANEL_X1 - PANEL_X0)


def build(
    rows: list[dict],
    gold_score: int = 5,
    purple_score: int = 3,
    header_text: str | None = "DMG",
    read_scores: bool = True,
    gap: int = ROW_GAP,
):
    """Returns (png bytes, fixture spec) for the given rows.

    A row may carry a `handle`: the board then prints it as an `@handle` under
    the display name, which is how the game shows a player who set one. `gap=0`
    removes the seam between rows, so consecutive players of one team sit on a
    single continuous stripe, as they do in a real 4v4 board.
    """
    height = HEIGHT
    image = Image.new("RGB", (WIDTH, height), (9, 9, 11))
    draw = ImageDraw.Draw(image)
    name_font = _font(26)
    handle_font = _font(16)
    header_font = _font(22)
    score_font = _font(40)

    positions: list[tuple[int, int]] = []
    y = FIRST_ROW_Y
    previous: str | None = None
    for row in rows:
        if previous is not None and row["team"] != previous:
            y += TEAM_GAP
        positions.append((y, y + ROW_HEIGHT))
        y += ROW_HEIGHT + gap
        previous = row["team"]

    draw.rectangle(
        (PANEL_X0 - 40, max(0, SCORE_TOP - 20), PANEL_X1 + 40, y + 20),
        fill=PANEL_BG,
    )

    # Each score sits in a box of its own team colour, as the game draws it.
    score_y = (SCORE_TOP + HEADER_TOP) // 2
    draw.rectangle(
        (SCORE_GOLD_X - SCORE_BOX, score_y - 28, SCORE_GOLD_X + SCORE_BOX, score_y + 28),
        fill=GOLD,
    )
    draw.rectangle(
        (
            SCORE_PURPLE_X - SCORE_BOX,
            score_y - 28,
            SCORE_PURPLE_X + SCORE_BOX,
            score_y + 28,
        ),
        fill=PURPLE,
    )
    draw.text(
        (SCORE_GOLD_X, score_y), str(gold_score), font=score_font, fill=INK, anchor="mm"
    )
    draw.text(
        (SCORE_PURPLE_X, score_y),
        str(purple_score),
        font=score_font,
        fill=INK,
        anchor="mm",
    )

    header_y = HEADER_TOP + ROW_HEIGHT // 2
    draw.text(
        (PANEL_X0 + 26, header_y), "PLAYER", font=header_font, fill=INK, anchor="lm"
    )
    if header_text:
        draw.text(
            (DMG_CENTER, header_y), header_text, font=header_font, fill=INK, anchor="mm"
        )
    draw.text((PANEL_X1 - 80, header_y), "EDA", font=header_font, fill=INK, anchor="mm")
    draw.text(
        (PANEL_X1 - 20, header_y), "PING", font=header_font, fill=INK, anchor="mm"
    )

    regions: dict[str, list[dict]] = {}
    header_tokens = [
        {"text": "PLAYER", "conf": 0.98, "x0": _frac(PANEL_X0 + 26), "x1": _frac(PANEL_X0 + 120)},
        {"text": "EDA", "conf": 0.95, "x0": _frac(PANEL_X1 - 100), "x1": _frac(PANEL_X1 - 60)},
        {"text": "PING", "conf": 0.95, "x0": _frac(PANEL_X1 - 40), "x1": _frac(PANEL_X1 - 4)},
    ]
    if header_text:
        header_tokens.insert(
            1,
            {
                "text": header_text,
                "conf": 0.97,
                "x0": _frac(DMG_CENTER - 30),
                "x1": _frac(DMG_CENTER + 30),
            },
        )
    regions["header"] = header_tokens

    for color, center, value in (
        ("gold", SCORE_GOLD_X, gold_score),
        ("purple", SCORE_PURPLE_X, purple_score),
    ):
        regions[f"score:{color}"] = (
            [
                {
                    "text": str(value),
                    "conf": 0.96,
                    "x0": _frac(center - 16),
                    "x1": _frac(center + 16),
                }
            ]
            if read_scores
            else []
        )

    for index, row in enumerate(rows):
        y0, y1 = positions[index]
        team = row["team"]
        if team == "mixed":
            draw.rectangle((PANEL_X0, y0, (PANEL_X0 + PANEL_X1) // 2, y1), fill=GOLD)
            draw.rectangle(((PANEL_X0 + PANEL_X1) // 2, y0, PANEL_X1, y1), fill=PURPLE)
        else:
            draw.rectangle(
                (PANEL_X0, y0, PANEL_X1, y1), fill=GOLD if team == "gold" else PURPLE
            )
        middle = (y0 + y1) // 2
        name_y = middle - 8 if row.get("handle") else middle
        draw.text(
            (PANEL_X0 + 26, name_y),
            row["username"],
            font=name_font,
            fill=INK,
            anchor="lm",
        )
        if row.get("handle"):
            draw.text(
                (PANEL_X0 + 26, middle + 14),
                f"@{row['handle']}",
                font=handle_font,
                fill=INK,
                anchor="lm",
            )
        if row.get("damage") is not None:
            draw.text(
                (DMG_CENTER, middle),
                f"{row['damage']:,}",
                font=name_font,
                fill=INK,
                anchor="mm",
            )

        tokens = [
            {
                "text": row.get("ocr_username", row["username"]),
                "conf": row.get("username_conf", 0.95),
                "x0": _frac(PANEL_X0 + 26),
                "x1": _frac(PANEL_X0 + 26 + max(60, 13 * len(row["username"]))),
            }
        ]
        if row.get("damage") is not None:
            tokens.append(
                {
                    "text": f"{row['damage']:,}",
                    "conf": row.get("damage_conf", 0.94),
                    "x0": _frac(DMG_CENTER - 30),
                    "x1": _frac(DMG_CENTER + 30),
                }
            )
        regions[f"row:{index}"] = tokens

    # The pipeline reads the table's text in one pass and uses it to tell two
    # players of the same team apart, so these tokens are positions inside that
    # crop. `row` lets a test blank one player's text.
    table_top = positions[0][0]
    table_bottom = positions[-1][1]
    table_height = max(1, table_bottom - table_top)

    def table_y(value: float) -> float:
        return (value - table_top) / table_height

    table_tokens: list[dict] = []
    for index, row in enumerate(rows):
        y0, y1 = positions[index]
        middle = (y0 + y1) // 2
        name_y = middle - 8 if row.get("handle") else middle
        table_tokens.append(
            {
                "text": row.get("ocr_username", row["username"]),
                "conf": row.get("username_conf", 0.95),
                "x0": _frac(PANEL_X0 + 26),
                "x1": _frac(PANEL_X0 + 26 + max(60, 13 * len(row["username"]))),
                "y0": table_y(name_y - 12),
                "y1": table_y(name_y + 12),
                "row": index,
            }
        )
        if row.get("handle"):
            table_tokens.append(
                {
                    "text": f"@{row.get('ocr_handle', row['handle'])}",
                    "conf": row.get("handle_conf", 0.93),
                    "x0": _frac(PANEL_X0 + 26),
                    "x1": _frac(PANEL_X0 + 26 + max(40, 9 * (len(row["handle"]) + 1))),
                    "y0": table_y(middle + 8),
                    "y1": table_y(middle + 20),
                    "row": index,
                }
            )
        if row.get("damage") is not None:
            table_tokens.append(
                {
                    "text": f"{row['damage']:,}",
                    "conf": row.get("damage_conf", 0.94),
                    "x0": _frac(DMG_CENTER - 30),
                    "x1": _frac(DMG_CENTER + 30),
                    "y0": table_y(name_y - 12),
                    "y1": table_y(name_y + 12),
                    "row": index,
                }
            )
    regions["table"] = table_tokens

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue(), {"regions": regions, "rows": rows}


class FakeReader:
    """Returns the fixture's own text, so the OCR engine is not needed."""

    name = "fake"

    def __init__(self, spec: dict, blank: tuple[str, ...] = ()):
        self.spec = spec
        self.blank = set(blank)

    def read(self, image, region: str = "row", box=None):
        from rivals_ocr.recognize import TextLine

        if region in self.blank:
            return []
        height, width = image.shape[:2]
        lines = []
        for token in self.spec["regions"].get(region, []):
            # Blanking a row blanks that player's text in the table pass too.
            if token.get("row") is not None and f"row:{token['row']}" in self.blank:
                continue
            if box is None:
                left = token["x0"] * width
                right = token["x1"] * width
            else:
                # Fixture coordinates are fractions of the panel, so a crop that
                # starts inside the panel has to be offset back.
                left = PANEL_X0 + token["x0"] * (PANEL_X1 - PANEL_X0) - box[0]
                right = PANEL_X0 + token["x1"] * (PANEL_X1 - PANEL_X0) - box[0]
            lines.append(
                TextLine(
                    token["text"],
                    float(token.get("conf", 0.95)),
                    (
                        left,
                        token.get("y0", 0.2) * height,
                        right,
                        token.get("y1", 0.8) * height,
                    ),
                )
            )
        return lines
