# Real RIVALS captures

Drop real screenshots of the in-game **Tab** scoreboard here, one image plus one
sidecar per capture. The pipeline's thresholds were tuned on generated fixtures;
these files are how the pipeline is measured against the actual game UI.

```
ocr/tests/captures/
  match-2026-11-27.png
  match-2026-11-27.truth.json
```

- Supported: `.png`, `.jpg`, `.jpeg`, `.webp`, up to 8 MB and 4096 px.
- Nothing in this directory is committed except this README and `.gitkeep`
  (`.gitignore` excludes the rest), so captures stay on your machine.
- An image without a sidecar is an error, not a skip: it means a capture cannot
  be measured.

## The sidecar

`<name>.truth.json` holds what the screenshot really says. Only the keys you
include are checked; omit a field you cannot read by eye, and write `null` when
the true value is genuinely unreadable (a blank damage cell, a hidden row).

```json
{
  "note": "optional free text, e.g. which game mode or UI scale",
  "transform": { "crop": [0, 0, 2560, 1440], "scale": 0.5, "rotate": 0 },
  "teams": { "gold": 5, "purple": 3 },
  "winner": "gold",
  "rows": [
    { "username": "sniperking", "team": "gold", "damage": 12345 },
    { "username": "ZeroHero", "team": "gold", "damage": 0 },
    { "username": "purplepal", "team": "purple", "damage": null }
  ]
}
```

| Key | Meaning |
|---|---|
| `rows` | One entry per **on-screen** row, in the order they appear. Required. A player scrolled off the bottom edge is left out entirely — do not add a row with blank fields for them. |
| `rows[].username` | The Roblox handle as displayed, without the leading `@` (the line under the display name), compared case-sensitively. Omit the key for a row whose handle you cannot read with certainty — `I`/`l`/`i`, `0`/`O` and `__`/`_` are ambiguous at this text size — and say why in a `note`. |
| `rows[].damage` | Integer as displayed, without separators. `0` is a real value; `null` means the truth is unreadable, and the pipeline must also leave it blank. |
| `rows[].team` | `"gold"` or `"purple"`. |
| `teams` | Team scores by colour. |
| `winner` | `"gold"`, `"purple"`, or `null` for a tie or hidden scores. |
| `transform` | Optional, applied before scanning: `crop` `[x, y, w, h]`, `scale` multiplier (0.5 halves), `rotate` 0/90/180/270. Use it only when a capture needs it, e.g. a downscaled export or a sideways phone photo. |

## Running it

```sh
bun run ocr:captures                     # or: python ocr/tools/measure_captures.py
python ocr/tools/measure_captures.py --min-damage 0.95 --min-username 0.95
```

It prints, per capture, each row's expected and read username, damage and team,
then the team scores and winner, then accuracy totals and a `RESULT: PASS/FAIL`
line. It exits non-zero when any field is below its threshold (default: every
field must be 100%) or when a sidecar is missing or malformed. With no captures
at all it prints a "no captures" message and exits 0, because nothing has been
measured yet.

`python ocr/tests/run_tests.py` runs the same measurement as a test and skips it
when this directory has no images.

## Reading a failure

- **Wrong username** — recognition, or the crop is picking up the rank column.
  Look at `layout.parse_row`'s left-of-DMG rule first.
- **Blank damage** — the DMG header was not read, or the number landed outside
  the column tolerance. `header_unreadable` in the document's issues says which.
- **Wrong team** — the row stripe's gold/purple mask is cut by a HUD element;
  check `layout.GOLD_LOW/HIGH` and `PURPLE_LOW/HIGH` against that screenshot.
- **Missing rows** — the band detector did not see a stripe (a transparent or
  very dark row background), or two rows merged into one tall band. Rows are
  split by the text in them, so several players sharing one continuous stripe
  (every 4v4 capture here) still come out as separate rows.
- **Wrong or missing username** — check that the row's `@handle` line was
  recognised; a row with no handle in the image legitimately falls back to the
  display name.
- **No scoreboard found** — the screenshot is not the Tab scoreboard, or the
  colour masks miss that UI skin entirely.
