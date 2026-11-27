# RIVALS scoreboard OCR service

Reads a screenshot of the RIVALS in-game Tab scoreboard and returns the player
rows, their damage, their team and the two team scores. It exists so the Worker
never has to embed a native OCR engine and so the OCR credential never reaches
the browser.

Images are processed **in memory only**: nothing is written to disk, and no
image data or token is logged. The service requires a bearer token and refuses to
start without one.

## Run it

```sh
python -m venv .venv                                   # from ocr/, or use the root venv
.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
.venv/bin/pip install -r requirements.txt                     # macOS / Linux

OCR_SERVICE_TOKEN=dev-secret .venv/Scripts/python.exe serve.py
# rivals-ocr: listening on http://127.0.0.1:8000 (engine=paddleocr)
```

The first start downloads the PP-OCR models (cached by PaddleX) and warms the
engine once, so the first upload is not the slow one.

| Variable | Default | Meaning |
|---|---|---|
| `OCR_SERVICE_TOKEN` | *(required)* | Shared bearer token. The service exits without it. |
| `OCR_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in a container. |
| `OCR_PORT` | `8000` | Port. |
| `OCR_MAX_BYTES` | `8388608` | Largest accepted upload. Keep it at or below the Worker's 8 MB. |
| `OCR_MAX_DIMENSION` | `4096` | Longest accepted side, in pixels. |
| `OCR_LANG` | `en` | PaddleOCR recognition language. |
| `OCR_VERBOSE` | unset | `1` logs one line per request (never the body). |

## Interface

### `GET /health`

Liveness and engine name only — no user data, no auth.

```json
{ "ok": true, "version": 1, "engine": "paddleocr" }
```

### `POST /scan`

Raw image bytes as the body (`Content-Type: image/png`, `image/jpeg` or
`image/webp`), with `Authorization: Bearer <token>`. No multipart wrapper, so the
Worker can forward the bytes it already holds. The response is the extraction
document below.

Errors are JSON with an HTTP status:

```json
{ "ok": false, "error": { "code": "unsupported_type", "message": "Only PNG, JPEG or WebP screenshots are supported." } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_image` | empty, undecodable, too small or too many pixels |
| 401 | `unauthorized` | missing or wrong bearer token |
| 413 | `too_large` | above `OCR_MAX_BYTES` |
| 415 | `unsupported_type` | magic bytes are not PNG/JPEG/WebP |
| 422 | `scoreboard_not_found` | no team-coloured row structure was found |
| 500/503 | `engine_unavailable` | PaddleOCR is missing or failed on the image |

### Response

```json
{
  "version": 1,
  "image": { "width": 1280, "height": 720 },
  "teams": [
    { "slot": 0, "color": "gold", "score": 5, "confidence": 0.94 },
    { "slot": 1, "color": "purple", "score": 3, "confidence": 0.94 }
  ],
  "winnerSlot": 0,
  "rows": [
    {
      "index": 0,
      "teamSlot": 0,
      "color": "gold",
      "username": "sniperking",
      "usernameConfidence": 0.96,
      "damage": 12000,
      "damageConfidence": 0.93,
      "rawDamageText": "12,000",
      "issues": []
    }
  ],
  "issues": [
    { "code": "damage_unreadable", "message": "Damage could not be read — enter it by hand.", "rowIndex": 2, "field": "damage" }
  ]
}
```

Rules the Worker and the UI rely on:

- `damage` is `null` when unreadable — **never** `0` unless a genuine zero was
  read. `username` is `null` when no text was recognised.
- `winnerSlot` is `null` when the scores tie or either score is unreadable; the
  user must pick the winner.
- `teamSlot` is `null` when a row's colour is ambiguous.
- Issue codes: `row_obscured`, `damage_unreadable`, `username_unreadable`,
  `team_ambiguous`, `header_unreadable`, `score_ambiguous`, `low_confidence`.
- Confidence values are `0..1`: recognition score combined with layout evidence,
  not a probability that the value is correct.

## Pipeline

`pipeline.py` runs the stages in order; `layout.py` holds the geometry and the
text parsing, `recognize.py` wraps the engine, `imaging.py` validates uploads.

1. **Validation** — magic bytes, byte cap, decode with OpenCV, dimension caps.
2. **Scoreboard detection** — team-colour masks (gold HSV hue ≈ 21, purple ≈ 130);
   no wide horizontal stripe means `scoreboard_not_found`.
3. **Row segmentation** — one band per colour stripe. Team-mates share one
   continuous stripe, so a band is cut where the text in it starts and stops (a
   band with no text at all is split by the typical row height instead), and a
   trailing band shorter than 70% of a row is dropped: that is the next player
   scrolled off the bottom edge, not a row. Rows are found wherever they are, so
   the screenshot can be cropped or scaled.
4. **Username extraction** — OCR of the row crop; tokens left of the DMG column,
   rank digits dropped, and the `@handle` line is preferred over the display
   name above it (the `@` is stripped). A row with no handle line falls back to
   its display name. Roster matching is therefore by Roblox handle.
5. **Damage extraction** — numeric tokens whose centre falls inside the DMG
   column; commas stripped; unreadable stays `null`.
6. **Team-colour classification** — the dominant mask inside the row's stripe;
   a mixed stripe is ambiguous rather than a coin flip.
7. **Team-score extraction** — the strip is found by its large white numerals
   (the HUD background colour changes with the map), each team's box by its own
   colour, and the score is read from the end of the box that faces the timer,
   where it is drawn — the rest of a box holds avatars and coin badges. Scores
   too small to be a score are refused, so a badge is never reported as one.
8. **Winner determination** — higher score; a tie or missing score leaves it
   unset.
9. **Structured JSON** — the document above, with per-row issues.

The DMG column comes from the header label (`DMG` or `DAMAGE`) and `EDA`/`PING`
are ignored. If the header cannot be read, every damage is reported as missing
with a `header_unreadable` issue rather than inferred from column position.

### Injecting a reader

`TextReader.read(image, region)` returns `TextLine(text, confidence, box)` where
`region` is `"header"`, `"score"` or `"row:<n>"` and `box` is in crop
coordinates. Tests use a fixture reader with the same interface, so geometry and
parsing are verified without PaddleOCR; production uses `PaddleTextReader`
(PaddleOCR 3.x `predict`, with a 2.x `ocr` fallback).

## Tests

```sh
python tests/run_tests.py       # from ocr/, or `bun run ocr:test` from the root
```

The suite covers username and damage extraction, zero damage, team colours in
either order, winners, ties, obscured rows, missing damage, an unreadable header
or score, ambiguous colours, upload limits and the HTTP interface. Fixtures are
**generated synthetic scoreboards**, not captures: they prove the pipeline logic,
not real-world OCR accuracy.

`tests/test_engine.py` closes half that gap: it renders the same synthetic
scoreboard and runs the **real** PaddleOCR through `PaddleTextReader`, asserting
every row's username and damage, the team colours, both scores and the winner. A
failure there is an engine-adapter or crop problem; a failure in the fixture
tests is a geometry problem. It is skipped when PaddleOCR is not installed (the
rest of the suite never needs it) and when `OCR_SKIP_ENGINE=1` is set, since
loading the models costs a few seconds.

### Real captures

The other half is measured, not assumed. Put real Tab scoreboard screenshots in
`tests/captures/` with a `<name>.truth.json` sidecar (format and failure guide in
`tests/captures/README.md`), then run `bun run ocr:captures` from the root or
`python tools/measure_captures.py` here. It prints a per-row expected-vs-read
diff, the team scores and winner, per-field accuracy and a `RESULT: PASS/FAIL`
line, exiting non-zero below the thresholds (100% each by default; tune with
`--min-username`, `--min-damage`, `--min-team`, `--min-score`, `--min-winner`).
With an empty directory it says so and exits 0 — nothing measured is not the
same as something failing. `tests/test_captures.py` runs the same measurement
and skips while the directory is empty, so `python tests/run_tests.py` stays
green on a fresh checkout. Captures are git-ignored.

## Docker

```sh
docker build -t rivals-ocr ocr
docker run -p 8000:8000 -e OCR_SERVICE_TOKEN=... rivals-ocr
```

Mount a volume for the model cache if cold starts matter. Terminate TLS in front
of it (a reverse proxy or the host's ingress) — the Worker should reach it over
HTTPS, except on loopback during development. Do not expose it without the
token: the service itself refuses to start without one.

## Why not Cloudflare or Vercel

Cloudflare Workers (including Python Workers) cannot load OpenCV or
PaddlePaddle's native code, and Sites only deploys Worker fetch handlers. Vercel's
Python functions cap the bundle at 500 MB (5 GB on the Large Functions beta) and
a cold start would have to download or mount the Paddle models, so neither host
is a good fit for this service. The app itself stays on Sites/Vercel; only the
OCR call leaves it.

## Limitations

- Layout tuning is validated against synthetic fixtures. A real RIVALS screenshot
  has not been used, so thresholds may need adjusting for the live UI.
- Two teams, vertical Tab scoreboard, rows of roughly equal height.
- The DMG column needs a readable header; without it damage is left blank.
- Rows without a visible colour gap may merge; a very tall band is split by the
  typical row height and anything still merged is flagged, not invented.
- Roblox display names differ from usernames; the row's `@handle` is read and
  matching uses `players.username`. A row without a handle line, or a handle the
  engine misreads (`I`/`l`/`i`, `0`/`O`, `__`/`_` at 12–14 px), relies on the
  suggestion/review path.
- Rows scrolled off the bottom edge are ignored by design; a capture that is cut
  mid-row loses that player instead of importing a partial row.
