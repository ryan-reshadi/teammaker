# Teammaker

Balanced teams from a rated roster. Rate everyone once from 1 to 10, choose how
many teams you need and how close their totals must be, and Teammaker returns
every split that fits — ranked by tightness and deliberately different from each
other. Players can sit out a round, and the app suggests who should sit next so
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

- **Roster** — add a player with a name and a skill. The skill is set on a
  ten-tick control with a numeric readout, names rename inline, and
  "Add several at once" pastes a newline- or comma-separated list (everyone joins
  at skill 5). The header tracks player count, total skill, average and how many
  are sitting out.
- **Roles** — every player can carry any number of shooter roles (sniper, push,
  anti-push, entry, support, flank, IGL, flex). They persist with the player and
  are used to give each team a working composition, not just equal totals.
- **Build** — pick 2–8 teams and a tolerance from 0 to 20, then generate. Each
  result is a set of colour-coded team columns with per-team sums, a proportional
  balance bar and a spread chip, paged with next/previous through up to 12
  arrangements.
- **Sit out** — a per-player toggle removes someone from generation and dims their
  row. When the available players do not divide evenly, the helper names who
  should sit (fewest saved rounds sat, then lowest skill) and can apply it in one
  click.
- **Saved rounds** — save a result to keep a snapshot of the teams, tolerance,
  spread and bench. Sit-out counts are derived from these saved rounds.
- **Accounts** — works immediately on this device; signing in with Freebuff syncs
  the roster and saved rounds to D1.

## How the balancing works

Everything lives in `src/shared/balance.ts`: pure, deterministic, no React, no
DOM, no network, so the same code runs in a Web Worker, in tests and on the
server.

1. **Even team sizes.** With `P` available players and `N` teams,
   `base = floor(P/N)` and exactly `P % N` teams hold one extra player.
2. **A global bound.** For total skill `S` and tolerance `t`, any valid split must
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
   `exhaustive: true` means the whole tree was visited, so nothing was missed.
5. **Variety.** Candidates are sorted by spread, then by squared deviation from
   the mean, then greedily thinned: each new arrangement is the one furthest (in
   players moved) from everything already chosen. The page shows up to 12.
6. **Fallback.** If nothing fits the tolerance, a greedy assignment refined by
   best-swap hill climbing returns the closest reachable split, labelled as over
   tolerance. If that split happens to fit the tolerance it is reported as
   within it.

### Guarantees

- Every returned arrangement uses each available player exactly once, with team
  sizes as even as possible.
- With `exhaustive: true`, the arrangements cover every valid split of that
  roster at that tolerance, up to the 12 shown.
- Skills are integers 1–10, so sums and spreads are exact — no floating point
  drift.

### Limits

- The search is bounded, not exhaustive by construction. Large rosters with a
  loose tolerance can hit the result or time cap; the caption then says the
  search wrapped up early rather than claiming completeness.
- Only team sums are balanced. There is no notion of positions, roles or
  individual matchups (a 10 and a 1 can be paired with two 5s and look identical
  in total).
- At most 12 arrangements are returned and at most 200 are collected, so a very
  permissive tolerance shows a varied sample rather than every combination.
- Saved rounds are capped at the newest 100 per account; new saves prune older
  ones.

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
signature like any other input.

## Data model

```sql
players(id TEXT PRIMARY KEY, owner_sub TEXT, name TEXT, skill INTEGER,
        tags TEXT, sitting_out INTEGER, created_at INTEGER, updated_at INTEGER)

rounds(id TEXT PRIMARY KEY, owner_sub TEXT, config TEXT, created_at INTEGER)
```

`players.tags` is a JSON array of role ids (`'["sniper","igl"]'`). Workspaces
created before roles existed are migrated in place: `ensureSchema` checks
`PRAGMA table_info(players)` and adds the column once with a default of `[]`.

`rounds.config` is a JSON snapshot:

```json
{
  "teamCount": 3,
  "tolerance": 0,
  "spread": 0,
  "teams": [
    {
      "sum": 24,
      "players": [{ "id": "…", "name": "Ada", "skill": 9, "tags": ["sniper", "igl"] }]
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
| POST | `/api/players` | `{ name, skill, tags? }` or `{ players: [...] }` (max 50) |
| PATCH | `/api/players/:id` | any of `name`, `skill`, `tags`, `sittingOut` |
| DELETE | `/api/players/:id` | |
| GET | `/api/rounds` | newest 60 snapshots |
| POST | `/api/rounds` | `{ config }`, validated and pruned to 100 |
| DELETE | `/api/rounds/:id` | |

Data routes answer 401 when signed out, 403 for cross-origin mutations, 400 for
invalid input, 413 above 64 KB and 503 when no database is bound. Responses are
`Cache-Control: private, no-store` and every query binds parameters.

## Tests

`bun test` runs four suites:

- `tests/balance.test.ts` — team sizes, a known perfect split, all 15 partitions
  of six equal players, **brute-force cross-checks** for equal and unequal team
  sizes, the strong-player-singleton case that a per-index size vector would
  miss, the over-tolerance fallback (including a fallback that fits), capped
  searches, uneven rosters and sit-out suggestions.
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
  403s and the no-database path. This is the suite that covers the Vercel
  deployment; `tests/app.test.ts` keeps covering D1.

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
