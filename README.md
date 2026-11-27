# Teammaker

Balanced teams from an elo-rated roster. Rate everyone once from 1 to 10 to seed
their elo (100 points a point, 100–1000), log the damage from real matches, and
the ratings tune themselves from there. Choose how many teams you need and how
close their elo totals must be, and Teammaker searches for splits that fit —
ranked by tightness and deliberately different from each other. Each result
shows the teams' pre-match win odds, and pair rules can keep players together or
apart. Players can sit out a round, and the app suggests who should sit next so
the bench stays fair.

A single-page React app served by a Hono Worker on Freebuff Sites, with a D1
database for signed-in rosters and a device-local fallback that works without an
account.

## Run it

```sh
bun install
bun run dev        # http://127.0.0.1:5173
bun run typecheck  # client and Worker TypeScript
bun test           # solver + API suites
bun run build      # dist/client assets and the dist/teammaker Worker
```

The dev server runs the real Worker against a local D1 database, so roster and
round persistence work without provisioning anything. With no auth configuration
on a loopback origin the server reports a clearly labelled `Local preview`
identity; that fallback never applies on a hosted origin or to incomplete
sign-in configuration.

## What it does

- **Roster** — add a player with a name and a rating. The ten-tick control shows
  the elo band and seeds a new player at rating × 100; the badge beside it shows
  the exact elo and opens an advanced field that edits it directly. Names rename
  inline, and "Add several at once" pastes a newline- or comma-separated list
  (everyone joins at 5 / 500). The header tracks player count, total elo, average
  and how many are sitting out.
- **Roles** — every player can carry any number of shooter roles (sniper, push,
  anti-push, entry, support, flank, IGL, flex). They persist with the player and
  are used to give each team a working composition, not just equal totals.
- **Build** — pick 2–8 teams and an elo tolerance from 0 to 2000, then generate.
  Each result is a set of colour-coded team columns with per-team elo sums, a
  proportional balance bar, that team's elo-only win odds and a spread chip,
  paged with next/previous through up to 12 arrangements. A collapsed **Pair
  rules** editor keeps chosen players together or apart as hard constraints, and
  **Role preference** can trade up to 50 or 100 extra spread for fuller role
  coverage.
- **Sit out** — a per-player toggle removes someone from generation and dims their
  row. When the available players do not divide evenly, the helper names who
  should sit (fewest logged matches sat, then lowest skill) and can apply it in
  one click. Logged matches are the source; saved rounds are the fallback until
  the first match exists.
- **Matches** — log a played match with two to eight teams: pick roster players
  or add unnamed randoms, enter each player's damage, add or remove teams, and
  pick the winning team. Every match is kept in an editable, reorderable log;
  editing or deleting one replays the ratings that follow it.   The account K
  applies to every match, a player's first one included. A K control tunes
  future matches only. **Rematch** refills the form with the same
  line-ups and blank damage, and the elo badge opens a per-player sparkline and
  before/after history. **Import from RIVALS Screenshot** reads a Tab scoreboard
  into the same form for review — see below.
- **Saved rounds** — save a result to keep a snapshot of the teams, tolerance,
  spread and bench. The snapshot is a memory aid; bench fairness prefers logged
  matches and falls back to these rounds before the first match exists.
- **Accounts** — works immediately on this device; signing in with Freebuff syncs
  the roster and saved rounds to D1.

## How the balancing works

Everything lives in `src/shared/balance.ts`: pure, deterministic, no React, no
DOM, no network, so the same code runs in a Web Worker, in tests and on the
server.

1. **Even team sizes.** With `P` available players and `N` teams,
   `base = floor(P/N)` and exactly `P % N` teams hold one extra player.
2. **A global bound.** For total elo `S` and tolerance `t`, any valid split must
   keep every team sum inside

   ```
   (S - (N-1)t) / N  <=  team sum  <=  (S + (N-1)t) / N
   ```

   because `max - min <= t` forces both extremes close to the mean. Bounds are
   rounded to integers, and the search prunes the moment a partial team sum
   passes the upper bound, or a full team falls short of the lower bound. With a
   tight tolerance this removes whole subtrees.
3. **Canonical enumeration.** Players are visited strongest first. A team is
   opened only in order — no empty team before a filled one — so each partition
   of the roster into labelled teams appears exactly once and team-permutation
   duplicates never occur. A final canonical key guards against twins.
4. **Caps.** The search stops after 300 ms, 500,000 nodes or 200 valid results.
   `exhaustive: true` means the whole tree was visited: `validCount` is exact
   and nothing was missed. When it is false, the count is a **lower bound** and
   the interface says so.
5. **Variety.** Candidates are sorted by spread, then role gaps, then squared
   deviation from the mean, then greedily thinned: each new arrangement is the
   one furthest (in players moved) from everything already chosen. The page
   shows up to 12.
6. **Fallback.** When the search finds no valid split, a greedy assignment
   refined by best-swap hill climbing returns a **best-effort** split. It is not
   guaranteed to be the true closest, so it is never presented as one. The
   presentation distinguishes three cases:
   - **Fits, complete:** a split found by an exhaustive search is a normal
     result with no best-effort label.
   - **Fits, early-stopped:** a fallback that happens to fit is labelled
     **Best effort** and explained as an incomplete search, never shown like a
     normal complete arrangement.
   - **Over tolerance:** a fallback outside the tolerance is labelled
     **Best effort** with a warning giving its spread; "no split fits" is only
     claimed when the search was exhaustive.

### Guarantees

- Every returned arrangement uses each available player exactly once, with team
  sizes as even as possible.
- With `exhaustive: true`, the count covers every valid split of that roster
  at that tolerance (and pair rules, when set); up to 12 of them are shown. When
  it is false, the count is a lower bound.
- Win odds come from the same `expectationsFromStrengths` helper as the rating
  engine, so the builder and the match result cannot disagree. They are
  elo-only: roles and damage are not part of the estimate.
- Elos are integers 100–1000, so sums and spreads are exact — no floating point
  drift.

### Limits

- The search is bounded, not exhaustive by construction. Large rosters with a
  loose tolerance can hit the result or time cap; the caption then reports a
  lower bound rather than claiming completeness, and "no split fits" is only
  said after an exhaustive search. The fallback split is best effort, not a
  proven optimum.
- Team sums are the primary balance. Roles only break ties or trade within the
  chosen role allowance, and there is still no notion of individual matchups (a
  10 and a 1 can be paired with two 5s and look identical in total).
- At most 12 arrangements are returned and at most 200 are collected, so a very
  permissive tolerance shows a varied sample rather than every combination.
- Pair rules and role preference are session-only. A saved round records the
  teams and bench it produced, not the builder controls that found them.
- Win odds are elo-only and pre-match. A data-driven calibration study is
  deferred until the log has enough matches; recalibrating later is a new formula
  version, never a silent rewrite of old events.
- Rolling back is clean only until the first v4 match is logged. Older builds
  ignore the `formula`/`k` marker, so after that keep this build or delete the v4
  events before rolling back; the v1 history itself is unaffected.
- Saved rounds are capped at the newest 100 per account; new saves prune older
  ones.

## How the ratings work

`src/shared/elo.ts` is pure and deterministic, like the solver.

- **Scale.** 100–1000, where 100 points is one point on the 1–10 control. Creating
a player at 1–10 sets their elo to rating × 100; the control always mirrors the
current band, and changing it snaps the elo to the new band's anchor. The
advanced field sets any elo in 100–1000.
- **One match, two terms.** The result term is ordinary Elo on the weighted rating
sums, so a five-stack is favoured over a four-stack. The performance term is
centred on zero and compares each player's share of the match's size-normalized
damage with the share their rating predicts. It carries 0.6 of K while the
result carries the full K, which is what makes a top-damage player on a losing
team land at roughly zero; the rest of the losing team still pays. Damage is also
compared with the entire lobby: beating more than half of everyone in the match
is a floor on the performance term, so a winning team's bottom fragger who still
out-damaged most of the field gains rating rather than losing it, while a
team-mate whose damage sits under the field's middle still pays.
- **More than two teams.** Each team is rated against every other team and the
head-to-head expectations are normalized to share out one win, so a settled
  three-way lobby is zero-sum like a duel. A win over a bigger field pays more than
  a duel at the same ratings.
- **Uneven teams.** Damage is divided by the number of enemies the player faced
(everyone outside their own team) before shares are compared, so a smaller
team's extra targets do not inflate their rating.
- **Randoms.** An unnamed player records damage but has no rating row. Their
rating is inferred from the lobby's known elo, shifted by their relative damage,
clamped to the scale, and counted at half a player's weight in both the
expectation and the damage pool. They are never updated.
- **No provisional window.** Every rated match uses the account K, including a
  player's first one. Matches logged under the older formulas (2 and 3) doubled K
  for a player's first five rated matches; they keep the deltas they were rated
  with, so no stored rating moves when the window was retired. New events are
  stamped formula 4, which reads no prior-match count at all.
- **K.** An account setting from 8 to 64, default 32. It applies to new matches
  only. Changing it freezes the K that produced existing ratings and never
  replays the log.
- **Win odds.** Each arrangement shows a pre-match win share from the weighted
  team elo sums. Two teams reduce to ordinary Elo; with more teams every pair is
  measured and the shares still add to 100%. The 400-point divisor calibrates a
  300-point gap to about 85/15 and a 500-point gap to about 95/5; those anchors
  are pinned in `tests/elo.test.ts`. A data-driven recalibration waits until
  enough matches exist and would be a new formula version, not a rewrite.
- **Replay.** Ratings start at each player's creation elo and are recomputed from
  the ordered event log. Every match and every manual elo edit stores each
  player's before/after elo, so editing, reordering or deleting an event restores
  exactly the ratings history would have produced. The log holds up to 1000 events.
- **Formula versions.** New events are stamped with formula 2 and the K used for
  them. Events written before this existed have no marker and are formula 1: they
  replay with the frozen legacy K stored in `rating_meta`, so replaying old
  history is byte-identical. Editing never upgrades an event; a v1 match stays v1
  and a v2 match keeps its recorded K. To inspect a proposed K without changing
  anything, run `bun run preview:replay [dbPath] [owner] [proposedK]`: it opens
  the local D1 file read-only and prints per-player current and proposed elo.
  There is no apply path.
- **Deleting players.** A player named in a match cannot be removed until those
matches are edited or deleted. Manual rating entries are removed with the player.

## Roles (the tag framework)

`src/shared/roles.ts` holds one fixed catalogue, so the client, the Worker and the
solver cannot drift apart:

| id | label | what it means |
|---|---|---|
| `sniper` | Sniper | long-range picks and sightlines |
| `push` | Push | takes space, forces the pace |
| `antipush` | Anti-push | holds a lane, stops the other side |
| `entry` | Entry | first through the door |
| `support` | Support | utility, smokes, heals, trades |
| `flank` | Flank | off-angles, lurk pressure |
| `igl` | IGL | calls the round |
| `flex` | Flex | fills whatever is missing |

A player holds any subset — a sniper who also calls the round is
`['sniper', 'igl']`. Tags are normalised on the server (unknown ids rejected,
duplicates dropped, catalogue order kept) and stored as a JSON array in
`players.tags`.

**How roles affect team making.** When two splits are equally close on skill, the
tighter role coverage wins, and the pager keeps the most different splits so the
choices genuinely vary. Coverage is defined as: for every role that at least
`N` players share (enough for one per team), count the teams with none of it.
Lower is better, and the tie-break order is
`spread → role gaps → squared deviation → canonical key`.

A role held by fewer players than there are teams is a specialist, never a "gap"
— one IGL on a twelve-player roster is not expected on all three teams. Each team
column shows its roles as compact chips, and the arrangement reports
"Role gaps: Team 2 has no Sniper" when the sums force a hole.

Turn the behaviour off with the **Spread roles** switch; the results are then
ranked purely on skill balance, and the toggle is part of the "roster changed"
signature like any other input. With roles on, **Role preference** can allow a
split up to 50 or 100 elo looser than the tightest if it closes role gaps; the
spread chip always shows the real spread, and the ranking is session-only.

Pair rules are hard, not preferences: every returned arrangement keeps a
"together" pair on one team and an "apart" pair on different teams. If no split
within the tolerance satisfies them, the result says so and offers to clear the
rules or widen the tolerance — a violating best-effort split is never shown.
Pair rules are also session-only and join the "roster changed" signature. If a
player sits out or leaves the roster, rules that mention them are dropped and a
notice says how many were removed.

## Importing a RIVALS screenshot

The match form has a second entry mode: **Import from RIVALS Screenshot**. Upload
a screenshot of the in-game Tab scoreboard and the app reads the player rows,
each player's DMG value, which team their row belongs to (gold or purple) and the
two team scores at the top — then asks you to review everything before submitting
an ordinary match.

- **Handles, not display names.** Each row's username is the Roblox handle
  printed under the display name (the `@name` line), so a roster player is
  matched by `destruction_lord9` rather than by `PVPDreadlord`. A row that shows
  no handle line falls back to its display name and is left for review.
- **Only what is on screen.** Rows are read where they are; a player whose row
  is scrolled off the bottom edge is not counted rather than imported with
  missing damage. All four team members in a 4v4 are read even though several
  share one continuous colour stripe.
- **Review first.** Nothing is submitted until every row has a username, a
  whole-number damage value and a team, at least one row is matched to a roster
  player, and the winner is chosen. A genuine `0` damage stays valid; damage that
  could not be read stays **blank** rather than becoming zero.
- **Roster matching.** `players.username` is the Roblox handle and is what gets
  compared. An exact, case-insensitive match is assigned automatically. A similar
  handle is only a **suggestion** (82% similarity or better) and needs a click;
  anything else can be kept as an untracked random. Two roster players with the
  same handle, or the same player twice, are marked **Needs review**. The importer
  never creates roster players.
- **Corrections.** Every detected username, damage, team and the winner can be
  edited, rows can be removed or moved between teams, the two teams can be
  swapped, and the whole screenshot can be rejected.
- **Submission.** A confirmed review becomes the same `MatchInput` the manual form
  sends (`label`, `teams`, `winner` only) through the same authenticated
  `POST /api/matches`. No OCR confidence, image data or extra properties are sent,
  and the elo engine is untouched: replay stays the only source of ratings.
- **No silent retries.** A failed or timed-out submission is never retried
  automatically, because the endpoint has no idempotency key. The review stays on
  screen, the match log is refreshed, and saving becomes possible again only after
  you have checked the log.

### The OCR service

The browser never talks to an OCR provider. `POST /api/rivals/scan` on the Worker
signs the request with a bearer token, forwards the image to a small Python
service and validates the JSON before returning it; the credential never reaches
the client. Screenshots are held in memory only, never written to storage, and
both sides cap size (8 MB) and pixel dimensions (4096). The route has its own
8 MB body limit, so the 64 KB limit every other data route depends on is
unchanged.

The service lives in `ocr/` and is optional at runtime: without
`OCR_SERVICE_URL` and `OCR_SERVICE_TOKEN` the UI says import is not configured and
everything else works as before. Run it locally with:

```sh
python -m venv ocr/.venv
ocr/.venv/Scripts/python.exe -m pip install -r ocr/requirements.txt   # Windows
# python3 -m venv ocr/.venv && ocr/.venv/bin/pip install -r ocr/requirements.txt
OCR_SERVICE_TOKEN=dev-secret ocr/.venv/Scripts/python.exe ocr/serve.py
```

Then copy `.dev.vars.example` to `.dev.vars` (the token must match) and run
`bun run dev`. `ocr/README.md` documents the request/response contract, the
pipeline stages, the Docker image and the hosting constraints.

### Measuring real screenshots

The pipeline's geometry is checked by generated fixtures in every test run, and
the real PaddleOCR engine is exercised by `ocr/tests/test_engine.py` against the
same fixture, so the reader adapter is known to match the installed engine. What
the fixtures cannot show is accuracy on the actual game UI.

To measure that, drop real Tab scoreboard screenshots in
`ocr/tests/captures/` — one image plus a `<name>.truth.json` sidecar holding what
the screenshot really says — and run:

```sh
bun run ocr:captures
```

It scans each capture with the real engine and prints, row by row, the expected
and read username, damage and team, then the two team scores and the winner,
followed by per-field accuracy (`username`, `damage`, `team`, `score`, `winner`)
with a `RESULT: PASS/FAIL` line and a non-zero exit when any field is below its
threshold — 100% by default, overridable with `--min-damage 0.95` and friends.
The captures directory is git-ignored, so screenshots stay on your machine;
`ocr/tests/captures/README.md` documents the sidecar format and how to read a
failure. `bun run ocr:test` runs the same measurement as a test and skips it
while the directory is empty.

Known limits: the layout is verified against synthetic fixtures and any captures
you add, not against the live game; only two teams and the vertical Tab
scoreboard are supported; the DMG column needs a readable header; a row without
a visible colour stripe is reported rather than guessed; and a handle is only as
reliable as 12–14 px text allows — `I`/`l`/`i`, `0`/`O` and double underscores
can be misread, and the review step is where you fix them.

## Data model

```sql
players(id TEXT PRIMARY KEY, owner_sub TEXT, name TEXT, skill INTEGER,
        elo INTEGER, base_elo INTEGER, tags TEXT, sitting_out INTEGER,
        created_at INTEGER, updated_at INTEGER)

rounds(id TEXT PRIMARY KEY, owner_sub TEXT, config TEXT, created_at INTEGER)

rating_events(id TEXT PRIMARY KEY, owner_sub TEXT, position INTEGER,
              kind TEXT, payload TEXT, created_at INTEGER, updated_at INTEGER)

rating_results(event_id TEXT, owner_sub TEXT, slot TEXT, player_id TEXT,
               name TEXT, elo_before INTEGER, elo_after INTEGER, delta INTEGER)

settings(owner_sub TEXT PRIMARY KEY, k_factor INTEGER, updated_at INTEGER)

rating_meta(owner_sub TEXT PRIMARY KEY, legacy_k INTEGER, created_at INTEGER)
```

`players.tags` is a JSON array of role ids (`'["sniper","igl"]'`). `elo` is the
live rating, `base_elo` is the creation anchor replay starts from, and `skill` is
a derived mirror (round(elo / 100)) kept so older readers and saved rounds still
work. Workspaces created before roles or elo existed are migrated in place:
`ensureSchema` reads `PRAGMA table_info(players)`, adds the missing columns and
sets `elo = base_elo = skill × 100` for existing players. No history is invented.

`rating_events.payload` is either a match (label, two to eight teams of players
with damage, the index of the winner, and — on new events only — `formula: 4`
and the base `k`) or a manual adjustment (player id, elo, reason). `rating_meta`
pins the K that produced pre-versioning ratings; it is written lazily, never
rewrites an event, and has no row until a K change or the first v2 match.
`rating_results` holds the per-player before/after bookkeeping for each event,
rewritten whenever the affected part of the log is replayed. Rows are scoped by
`owner_sub = user.sub`.

`rounds.config` is a JSON snapshot (version 2 uses the elo scale; rounds saved
before elo are scaled ×100 when read):

```json
{
  "version": 2,
  "teamCount": 3,
  "tolerance": 300,
  "spread": 0,
  "teams": [
    {
      "sum": 2500,
      "players": [{ "id": "…", "name": "Ada", "elo": 900, "tags": ["sniper", "igl"] }]
    }
  ],
  "benchedIds": ["…"]
}
```

Team names are snapshotted, so history still reads correctly after a player is
renamed or deleted. Everything is scoped by `owner_sub = user.sub`; a roster holds
up to 200 players.

## Guest mode vs synced

`src/client/store.ts` exposes one `Store` interface with two implementations.

| | Local (guest) | Remote (signed in) |
|---|---|---|
| Storage | `localStorage`: `teammaker.players.v1`, `teammaker.rounds.v1` | D1 through the Worker API |
| Header chip | "This device only" | "Synced" |
| Survives reload | yes, on this browser | yes, on any device |

The UI is identical either way. When a signed-in account has no players and this
device holds a guest roster, an import prompt offers to copy it into the account.
If the server cannot be reached at all, the app says so and keeps working on the
device.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/session` | current user, auth mode, database availability |
| GET | `/api/health` | liveness |
| GET | `/api/players` | oldest first |
| POST | `/api/players` | `{ name, username?, skill, tags? }` or `{ players: [...] }` (max 50) |
| PATCH | `/api/players/:id` | any of `name`, `username`, `skill`, `elo`, `tags`, `sittingOut` |
| POST | `/api/players/:id/elo` | `{ elo, reason? }`, logs a manual adjustment |
| DELETE | `/api/players/:id` | 409 while the player has match history |
| GET | `/api/matches` | the ordered rating log, with before/after elo |
| POST | `/api/matches` | `{ label?, teams: [team, …], winner }`, 2–8 teams |
| PATCH | `/api/matches/:id` | `{ input }` and/or `{ position }`, then replays |
| DELETE | `/api/matches/:id` | removes the event and replays the rest |
| GET | `/api/settings` | `{ kFactor }` |
| PUT | `/api/settings` | `{ kFactor }` 8–64; applies to new matches, never replays |
| GET | `/api/rounds` | newest 60 snapshots |
| POST | `/api/rounds` | `{ config }`, validated and pruned to 100 |
| DELETE | `/api/rounds/:id` | |
| GET | `/api/rivals/config` | screenshot import availability, size and type limits |
| POST | `/api/rivals/scan` | multipart `image`, proxied to the OCR service |

Data routes answer 401 when signed out, 403 for cross-origin mutations, 400 for
invalid input, 413 above 64 KB and 503 when no database is bound. The screenshot
route is the one exception to the body limit: it has its own 8 MB cap and its own
session guard, mounted ahead of the JSON limit rather than widening it. Responses
are `Cache-Control: private, no-store` and every query binds parameters.

## Tests

`bun test` runs these suites:

- `tests/elo.test.ts` — the 100-point scale, even and uneven matches, loss
  protection, random inference and half weight, clamping, manual adjustments,
  deterministic replay, edit/delete/reorder, K changes, win-odds calibration,
  flat K, the retired provisional K for older events, and v1/v2/v4 replay
  compatibility.
- `tests/balance.test.ts` — team sizes, a known perfect split, all 15 partitions
  of six equal players, **brute-force cross-checks** for equal and unequal team
  sizes, the strong-player-singleton case that a per-index size vector would
  miss, the over-tolerance fallback (including a fallback that fits), capped
  searches, uneven rosters, pair rules, role-allowance ranking and sit-out
  suggestions.
- `tests/presentation.test.ts` — component-level rendering of the result header
  and warning: a complete in-tolerance split has no best-effort marker, an
  early-stopped fallback that happens to fit still renders **Best effort** and
  the incomplete-search explanation, an over-tolerance fallback keeps its
  warning and widening action, and an impossible pair rule reports the failure
  instead of rendering a violating split.
- `tests/app.test.ts` — the real API against a Miniflare D1 database: CRUD, bulk
  add, two-user isolation, round snapshots, role tags round-tripping through
  create and patch (with unknown ids rejected), signed-out refusals, foreign and
  absent origins, malformed input, oversized bodies and the missing-database path.
- `tests/roles.test.ts` — the catalogue, tag normalisation and bitmasks, coverage
  gaps (including specialists being ignored), role ranking breaking ties between
  equally balanced splits, and a multi-role player counting for every role.
- `tests/libsql.test.ts` — the production libSQL adapter running against Bun's
  built-in SQLite: schema creation, the roles migration on a pre-roles table,
  CRUD with tags, round snapshots, two-account isolation, 401s, foreign-origin
  403s, the no-database path, and a legacy event that stays byte-identical through
  a K change, an edit and a new v2 match. This is the suite that covers the
  Vercel deployment; `tests/app.test.ts` keeps covering D1.
- `tests/history.test.ts` — per-player match/adjustment history and sparkline
  geometry.
- `tests/bench.test.ts` — sit-out counts from real matches, late joiners,
  adjustments and the saved-round fallback.
- `tests/rematch.test.ts` — line-up copying, fresh random keys, blank damage and
  missing-player refusal.
- `tests/rivals.test.ts` — the screenshot extraction contract, exact and
  case-insensitive roster matching, fuzzy suggestions that are never applied
  automatically, duplicate usernames and duplicate players, team swaps, zero
  damage, invalid damage and winner values, untracked randoms, the exact
  `MatchInput` payload, and the scan validator.
- `tests/rivals-import.test.ts` — the screenshot routes against Miniflare D1:
  signed-out 401s, foreign-origin 403s, the unconfigured 503, magic-byte
  rejection, the 8 MB cap, a 1 MB upload that the 64 KB JSON limit must not
  block, the unweakened JSON limit, the proxied OCR call and its bearer token,
  and upstream failures becoming 502s.

`python ocr/tests/run_tests.py` runs the OCR service's own suite against
synthetic scoreboard fixtures: username, damage, zero damage, team colours
(including swapped order), winners, ties, obscured rows, missing damage, an
unreadable header or score, ambiguous team colour, upload limits and the HTTP
interface's authentication. It needs only the packages in
`ocr/requirements.txt`; the PaddleOCR engine is not required for these tests.

## Deploying to Vercel

The app deploys to two hosts from one codebase. Nothing about the data layer is
vendor-specific: `src/worker/db.ts` defines the small `Database` interface the
routes use, Cloudflare D1 satisfies it directly, and `src/server/libsql.ts`
implements it over [libSQL/Turso](https://turso.tech) for Node hosts.

| Piece | Cloudflare (Sites) | Vercel |
|---|---|---|
| Browser bundle | `dist/client` | `dist-client` (`bun run build:vercel`) |
| Server | `dist/teammaker/index.js` | `api/index.ts` → a Node function |
| Database | D1 binding `DB` | libSQL over HTTP |
| Static files | Worker `ASSETS` binding | Vercel's own CDN |

The Vercel function is a **committed bundle**: `bun run build:api` compiles
`server/vercel.ts` into the single self-contained `api/index.js`. Vercel's Node
builder transpiles an `api/*.ts` entry without bundling it, so relative imports
into `src/` break at runtime with `ERR_MODULE_NOT_FOUND`; one file with only
package imports cannot fail that way. `bun run build:vercel` runs the client
build and this bundle together, so the deployed copy is always regenerated —
run `bun run build:api` and commit `api/index.js` after changing anything under
`src/worker`, `src/server` or `server/`.

`vercel.json` rewrites `/api/*` and `/auth/freebuff/*` to the function, then
falls back to `index.html` for deep links; `api/index.ts` binds the same Hono
app with `@hono/node-server` and wraps it in `auth.wrap` exactly like the
Worker entry, so sign-in, CSRF checks and `Cache-Control: private, no-store`
behave identically.

### Steps

1. **Project settings** — in the Vercel dashboard set Framework Preset to
   **Other**, Build Command `bun run build:vercel`, Output Directory
   `dist-client`, Install Command `bun install`, Node **22.x**. Dashboard values
   win over `vercel.json`, so they must match.
2. **Database** — Vercel Marketplace → Turso → install, then copy
   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. No migration step: the first
   request runs `CREATE TABLE IF NOT EXISTS` plus the roles-column guard.
3. **Sign-in** — register the exact production origin:
   `npx @freebuff/auth register --project teammaker --environment production
   --redirect-uri https://<your-domain>/auth/freebuff/callback`, then set
   `APP_ORIGIN`, `FREEBUFF_CLIENT_ID` and `FREEBUFF_ISSUER` in **Production**
   only. Preview deployments rotate their domain, so leaving auth out of Preview
   keeps them in a clean guest mode instead of a sign-in link that cannot
   complete.
4. **Check** — `/` must return HTML (not Vercel's 404), `/api/session` must
   report `database: true`, and a signed-out `/api/players` must be 401.

Without `TURSO_DATABASE_URL` the function reports `database: false` and the
client stays in guest mode with a notice, so a deploy is never broken by a
missing env var. The environment names are the same everywhere:

| Variable | Where | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL` | Vercel | libSQL connection |
| `TURSO_AUTH_TOKEN` | Vercel | libSQL token |
| `APP_ORIGIN` | Vercel / Sites | canonical origin for cookies and CSRF |
| `FREEBUFF_CLIENT_ID` / `FREEBUFF_ISSUER` | Vercel / Sites | public OIDC client |
| `OCR_SERVICE_URL` | Vercel / Sites | base URL of the OCR service (loopback in development) |
| `OCR_SERVICE_TOKEN` | Vercel / Sites | bearer token for that service; a secret, never public |

The OCR service is the one piece that cannot live on Sites or in the Vercel
function: Workers cannot run OpenCV/PaddlePaddle native code, and the Python
function bundle limit is a poor fit for Paddle's wheels and models. Run it as the
container in `ocr/Dockerfile` on any host that allows a small long-running
service, expose it over HTTPS, then set `OCR_SERVICE_URL` and
`OCR_SERVICE_TOKEN` for the app. Until both are set, the import mode reports that
it is not configured and no other feature changes.

`bun run serve:node` starts the same handler on `127.0.0.1:5174` under Bun
against a SQLite file. To exercise the **actual Vercel runtime path** — plain
Node, `@hono/node-server`'s `(req, res)` plumbing and the real libSQL driver —
build the function and run it:

```sh
bun run build:api    # bundles api/index.ts for Node into .tmp-api/api.mjs
bun run serve:api    # serves it on 127.0.0.1:5175 over .tmp-api/teammaker.db
```

It prints the port it actually bound (PORT overrides the default).

That harness is a loopback origin with no auth config, so it answers as the
local-preview identity and every route is reachable with curl. Point
`TURSO_DATABASE_URL` at a real database to test the hosted driver instead of a
file; set `APP_ORIGIN` and `FREEBUFF_CLIENT_ID` to exercise the sign-in redirect
(it returns a 303 to the issuer's authorize endpoint without a session).

## Publishing

Only when asked. Create or inspect the site, run `sites_add_storage` for `DB`,
run `sites_enable_auth` with the local Worker origin so sign-in works in
development, then build and deploy with `deploy.json`. Sites injects
`FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN`; no application secret is
stored in this project. Read `node_modules/@freebuff/auth/AGENTS.md` before
changing anything about sign-in.
