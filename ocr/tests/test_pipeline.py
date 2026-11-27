from __future__ import annotations

import io
import json
import os
import sys
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
OCR = os.path.dirname(TESTS)
sys.path.insert(0, OCR)
sys.path.insert(0, TESTS)

from fixtures import FakeReader, build  # noqa: E402
from PIL import Image  # noqa: E402
from rivals_ocr.imaging import ImageError, decode  # noqa: E402
from rivals_ocr.layout import Row, ScoreboardError, refine_rows  # noqa: E402
from rivals_ocr.pipeline import scan_image  # noqa: E402
from rivals_ocr.recognize import TextLine  # noqa: E402

ROWS = [
    {"username": "sniperking", "damage": 12345, "team": "gold"},
    {"username": "ZeroHero", "damage": 0, "team": "gold"},
    {"username": "ghostwalker", "damage": 812, "team": "gold"},
    {"username": "purplepal", "damage": 4321, "team": "purple"},
    {"username": "nightowl", "damage": 77, "team": "purple"},
]


def run(rows=None, blank=(), **options):
    png, spec = build(rows if rows is not None else ROWS, **options)
    return scan_image(png, FakeReader(spec, blank))


def row_by_name(result, username):
    return next(row for row in result["rows"] if row["username"] == username)


class ExtractionTests(unittest.TestCase):
    def test_usernames_and_order(self):
        result = run()
        self.assertEqual(
            [row["username"] for row in result["rows"]],
            ["sniperking", "ZeroHero", "ghostwalker", "purplepal", "nightowl"],
        )

    def test_damage_values(self):
        result = run()
        self.assertEqual(
            [row["damage"] for row in result["rows"]], [12345, 0, 812, 4321, 77]
        )
        self.assertEqual(row_by_name(result, "purplepal")["rawDamageText"], "4,321")

    def test_zero_damage_is_a_real_value(self):
        result = run()
        zero = row_by_name(result, "ZeroHero")
        self.assertEqual(zero["damage"], 0)
        self.assertGreater(zero["damageConfidence"], 0)
        self.assertNotIn(
            "damage_unreadable", [issue["code"] for issue in zero["issues"]]
        )

    def test_team_colours(self):
        result = run()
        self.assertEqual([row["teamSlot"] for row in result["rows"]], [0, 0, 0, 1, 1])
        self.assertEqual([row["color"] for row in result["rows"]], ["gold"] * 3 + ["purple"] * 2)

    def test_team_colours_follow_the_layout_not_the_order(self):
        rows = [
            {"username": "purplepal", "damage": 100, "team": "purple"},
            {"username": "nightowl", "damage": 200, "team": "purple"},
            {"username": "sniperking", "damage": 300, "team": "gold"},
        ]
        result = run(rows)
        self.assertEqual([row["teamSlot"] for row in result["rows"]], [1, 1, 0])

    def test_bad_ocr_username_is_passed_through_unchanged(self):
        rows = [{"username": "sniperking", "damage": 10, "team": "gold", "ocr_username": "sniperk1ng"}]
        result = run(rows)
        self.assertEqual(result["rows"][0]["username"], "sniperk1ng")

    def test_low_confidence_username_is_flagged(self):
        rows = [{"username": "sniperking", "damage": 10, "team": "gold", "username_conf": 0.4}]
        result = run(rows)
        codes = [issue["code"] for issue in result["rows"][0]["issues"]]
        self.assertIn("low_confidence", codes)

    def test_issues_never_include_machine_guessed_values(self):
        # A missing damage cell stays null; it is never turned into a zero.
        rows = [{"username": "sniperking", "damage": None, "team": "gold"}]
        result = run(rows)
        self.assertIsNone(result["rows"][0]["damage"])
        codes = [issue["code"] for issue in result["rows"][0]["issues"]]
        self.assertIn("damage_unreadable", codes)


FOUR_V_FOUR = [
    {"username": "Alpha", "handle": "alpha_one", "damage": 1665, "team": "gold"},
    {"username": "Bravo", "handle": "bravo_two", "damage": 1653, "team": "gold"},
    {"username": "Charlie", "damage": 1595, "team": "purple"},
    {"username": "Delta", "damage": 1524, "team": "gold"},
    {"username": "Echo", "damage": 1097, "team": "purple"},
    {"username": "Foxtrot", "damage": 1078, "team": "purple"},
]


class MultiPlayerTests(unittest.TestCase):
    """A 4v4 board, where team-mates share one continuous colour stripe."""

    def test_every_player_on_a_shared_stripe_is_its_own_row(self):
        result = run(FOUR_V_FOUR, gap=0)
        self.assertEqual(len(result["rows"]), len(FOUR_V_FOUR))
        self.assertEqual(
            [row["damage"] for row in result["rows"]],
            [1665, 1653, 1595, 1524, 1097, 1078],
        )
        self.assertEqual(
            [row["color"] for row in result["rows"]],
            ["gold", "gold", "purple", "gold", "purple", "purple"],
        )

    def test_the_roblox_handle_is_the_username(self):
        # The roster is indexed by the @handle, not by the display name above it.
        result = run(FOUR_V_FOUR, gap=0)
        self.assertEqual(
            [row["username"] for row in result["rows"]],
            ["alpha_one", "bravo_two", "Charlie", "Delta", "Echo", "Foxtrot"],
        )

    def test_an_obscured_player_in_a_shared_stripe_is_still_reported(self):
        result = run(FOUR_V_FOUR, gap=0, blank=("row:1",))
        self.assertEqual(len(result["rows"]), len(FOUR_V_FOUR))
        obscured = result["rows"][1]
        self.assertIsNone(obscured["username"])
        self.assertIn("row_obscured", [issue["code"] for issue in obscured["issues"]])


class RowRefinementTests(unittest.TestCase):
    def test_two_players_on_one_stripe_are_split_by_their_text(self):
        rows = [Row(0, 100, 220, 0, 100, "gold", 1.0)]
        lines = [
            TextLine("a", 0.9, (0, 106, 40, 126)),
            TextLine("1", 0.9, (60, 106, 90, 126)),
            TextLine("b", 0.9, (0, 166, 40, 186)),
            TextLine("2", 0.9, (60, 166, 90, 186)),
        ]
        refined = refine_rows(rows, lines)
        self.assertEqual([(row.y0, row.y1) for row in refined], [(100, 146), (146, 220)])
        self.assertTrue(all(row.color == "gold" for row in refined))

    def test_a_row_cut_by_the_bottom_edge_is_ignored(self):
        rows = [
            Row(0, 0, 60, 0, 100, "gold", 1.0),
            Row(1, 60, 120, 0, 100, "gold", 1.0),
            Row(2, 120, 143, 0, 100, "purple", 1.0),
        ]
        refined = refine_rows(rows, [])
        self.assertEqual([(row.y0, row.y1) for row in refined], [(0, 60), (60, 120)])

    def test_a_row_without_text_keeps_its_band(self):
        rows = [Row(0, 0, 60, 0, 100, "gold", 1.0), Row(1, 60, 120, 0, 100, "purple", 1.0)]
        self.assertEqual(len(refine_rows(rows, [])), 2)


class ScoreTests(unittest.TestCase):
    def test_winner_from_scores(self):
        result = run()
        self.assertEqual([team["score"] for team in result["teams"]], [5, 3])
        self.assertEqual(result["winnerSlot"], 0)

    def test_winner_for_purple(self):
        result = run(gold_score=2, purple_score=5)
        self.assertEqual(result["winnerSlot"], 1)

    def test_tie_requires_confirmation(self):
        result = run(gold_score=4, purple_score=4)
        self.assertIsNone(result["winnerSlot"])
        self.assertIn("score_ambiguous", [issue["code"] for issue in result["issues"]])

    def test_noise_around_a_score_is_tolerated(self):
        # A colour block merged into the detection ("\u25a15") is still a score.
        png, spec = build(ROWS)
        spec["regions"]["score:gold"][0]["text"] = "\u25a15"
        result = scan_image(png, FakeReader(spec))
        self.assertEqual([team["score"] for team in result["teams"]], [5, 3])
        self.assertEqual(result["winnerSlot"], 0)

    def test_unreadable_scores_leave_the_winner_blank(self):
        result = run(read_scores=False)
        self.assertEqual([team["score"] for team in result["teams"]], [None, None])
        self.assertIsNone(result["winnerSlot"])
        self.assertIn("score_ambiguous", [issue["code"] for issue in result["issues"]])

    def test_header_missing_marks_damage_missing(self):
        result = run(header_text=None)
        self.assertTrue(all(row["damage"] is None for row in result["rows"]))
        self.assertIn(
            "header_unreadable", [issue["code"] for issue in result["issues"]]
        )


class FailureTests(unittest.TestCase):
    def test_obscured_row_is_reported(self):
        result = run(blank=("row:2",))
        obscured = result["rows"][2]
        self.assertIsNone(obscured["username"])
        self.assertIsNone(obscured["damage"])
        codes = [issue["code"] for issue in obscured["issues"]]
        self.assertIn("row_obscured", codes)
        self.assertIn("damage_unreadable", codes)

    def test_ambiguous_team_colour(self):
        rows = [{"username": "sniperking", "damage": 10, "team": "mixed"}]
        result = run(rows)
        self.assertIsNone(result["rows"][0]["teamSlot"])
        codes = [issue["code"] for issue in result["rows"][0]["issues"]]
        self.assertIn("team_ambiguous", codes)

    def test_non_image_upload(self):
        with self.assertRaises(ImageError) as raised:
            decode(b"<html>not an image</html>")
        self.assertEqual(raised.exception.code, "unsupported_type")
        self.assertEqual(raised.exception.status, 415)

    def test_oversized_upload(self):
        png, _spec = build(ROWS)
        with self.assertRaises(ImageError) as raised:
            decode(png, max_bytes=1000)
        self.assertEqual(raised.exception.code, "too_large")
        self.assertEqual(raised.exception.status, 413)

    def test_oversized_dimensions(self):
        buffer = io.BytesIO()
        Image.new("RGB", (4200, 400), (20, 20, 20)).save(buffer, format="PNG")
        with self.assertRaises(ImageError) as raised:
            decode(buffer.getvalue(), max_dimension=4096)
        self.assertEqual(raised.exception.code, "invalid_image")

    def test_no_scoreboard_found(self):
        buffer = io.BytesIO()
        Image.new("RGB", (900, 600), (40, 40, 44)).save(buffer, format="PNG")
        with self.assertRaises(ScoreboardError):
            scan_image(buffer.getvalue(), FakeReader({"regions": {}}))


class DocumentTests(unittest.TestCase):
    def test_document_matches_the_contract(self):
        result = run()
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["image"], {"width": 1280, "height": 760})
        self.assertEqual([team["color"] for team in result["teams"]], ["gold", "purple"])
        self.assertEqual([team["slot"] for team in result["teams"]], [0, 1])
        self.assertIsInstance(result["rows"], list)
        self.assertIsInstance(result["issues"], list)
        for row in result["rows"]:
            self.assertEqual(
                set(row),
                {
                    "index",
                    "teamSlot",
                    "color",
                    "username",
                    "usernameConfidence",
                    "damage",
                    "damageConfidence",
                    "rawDamageText",
                    "issues",
                },
            )
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
