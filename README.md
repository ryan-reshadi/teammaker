# Teammaker

Balanced teams from an elo-rated roster — now a shared team tracker. Each
**group** is one roster with its own elo history and its own skill tags: make
one per game or friend circle, invite people with a link, and choose who can
edit. Editors record matches and change ratings; viewers read everything and
build teams on their own device. Who is sitting out and the teams you generate
never leave your browser.

A single-page React app served by a Hono Worker on Freebuff Sites, with a D1
database for shared groups and a device-local fallback that works without an
account.

## Run it

```sh
bun install
bun run dev        # http://127.0.0.1:5173
bun run typecheck  # client and Worker TypeScript
bun test           # solver, API, libSQL and browser suites
bun run build      # dist/client assets and the dist/teammaker Worker
```

The dev server runs the real Worker against a local D1 database, so groups,
sharing and ratings work without provisioning anything. With no auth
configuration on a loopback origin the server reports a clearly labelled
`Local preview` identity; that fallback never applies on a hosted origin or to
incomplete sign-in configuration.

## What it does

- **Groups** — the header switches between your groups and creates new ones.
  Each group has its own players, elos, match log, K and tags. Groups you own
  and groups shared with you appear in one list; the chip beside the switcher
  says whether you are the owner, can edit, or are view-only.
- **Sharing** — the owner opens **Share** and creates a viewer or editor invite
  link. Anyone signed in who opens the link joins with that role. The same panel
  lists everyone with access: change a role or remove somebody at any time.
  Links can be revoked and are stored only as hashes. There is no email lookup
  or delivery, by design.
- **Player connections** — after signing in on an invite, the visitor picks the
  roster player they are (“I'm already on the roster”) or proposes a new one with
  a display name and username — never an elo. Either choice is sent as a request
  with their account email (an account without one is asked for an address on
  the form) and an optional note; joining happens immediately, and any editor
  approves or dismisses the claim from **Requests**. A member who joined without
  connecting is prompted in the group and can file the same request from there.
  An approved new
  player starts at 0 elo with no tags and the proposer's email. Players can carry
  several emails (alternate accounts) and one email can sit on several players;
  editors connect or disconnect emails from a player's details.
- **Roster** — add a player with a name and a rating. The ten-tick control shows
  the elo band and seeds a new player at rating × 100; the badge beside it shows
  the exact elo and opens an advanced field that edits it directly. Names rename
  inline, and "Add several at once" pastes a newline- or comma-separated list
  (everyone joins at 5 / 500). The header tracks player count, total elo, average
  and how many are sitting out on this device.
- **Skill tags** — each group defines its own tags (up to 16) in the **Tags**
  dialog. Any player can carry any number of them. Tags are used to give each
  team a working composition, not just equal totals, and editors can rename,
  reorder or delete them; deleting a tag removes it from its players.
- **Build** — pick 2–8 teams and an elo tolerance from 0 to 2000, then generate.
  Each result is colour-coded team columns with per-team elo sums, a proportional
  balance bar, that team's elo-only win odds and a spread chip, paged through up
  to 12 arrangements. **Pair rules** keep chosen players together or apart as
  hard constraints, and **Tag preference** can trade up to 50 or 100 extra spread
  for fuller tag coverage.
- **Sit out** — a per-player toggle. It is stored in this browser only, separately
  for each group, and never written to the shared roster. When the available
  players do not divide evenly, the helper names who should sit (fewest logged
  matches sat, then lowest skill) and can apply it in one click. Logged matches
  are the source; saved rounds on this device are the fallback.
- **Matches** — log a played match with two to eight teams: pick roster players
  or add unnamed randoms, enter each player's damage, add or remove teams, and
  pick the winning team. Every match is kept in an editable, reorderable log;
  editing or deleting one replays the ratings that follow it. The group K applies
  to every new match. **Rematch** refills the form with the same line-ups and
  blank damage, and the elo badge opens a per-player sparkline and before/after
  history. **Import from RIVALS Screenshot** reads a Tab scoreboard into the same
  form for review.
- **Saved rounds** — saving a round keeps a snapshot of the teams, tolerance,
  spread and bench in this browser, for this group. It is never synced. Existing
  account rounds are offered once for import into the browser.
- **Live updates** — while a group is open, a small revision poll notices when
  someone else edits the roster, tags, log or K, and reloads the authoritative
  data. Open forms keep their draft; the new data lands behind them. If the
  owner removes you from the group, the next poll drops its shared data and
  tells you access was removed instead of leaving a stale roster on screen.

### Permissions

| Capability | Owner | Editor | Viewer |
|---|---|---|---|
| Read roster, tags, elo, match log | yes | yes | yes |
| Add/rename/remove players, edit elo, tags, log/edit matches | yes | yes | — |
| Connect/disconnect player emails, approve or dismiss player requests | yes | yes | — |
| File or cancel your own player-link request | yes | yes | yes |
| Rename group, change K | yes | yes | — |
| Invite links, member roles, remove members, delete group | yes | — | — |
| Sit-outs, generated teams, saved rounds (this device) | yes | yes | yes |

The server is the authority. Every `/api/groups/:id/*` route resolves membership
from `group_members`; non-members get 404 (no existence leak) and viewers get 403
on any mutation. Client role state is display only. All mutations are
same-origin checked, and responses are `Cache-Control: private, no-store`.

## How the balancing works

Everything lives in `src/shared/balance.ts`: pure, deterministic, no React, no
DOM, no network, so the same code runs in a Web Worker, in tests and on the
server.

1. **Even team sizes.** With `P` available players and `N` teams,
   `base = floor(P/N)` and exactly `P % N` teams hold one extra player.
2. **A global bound.** For total elo `S` and tolerance `t`, any valid split must
   keep every team sum inside `(S - (N-1)t)/N <= sum <= (S + (N-1)t)/N`.
   Bounds are rounded to integers, and the search prunes the moment a partial
   team sum passes the upper bound, or a full team falls short of the lower
   bound.
3. **Canonical enumeration.** Players are visited strongest first, teams open in
   order, and a final canonical key guards against twins, so each partition is
   produced exactly once.
4. **Caps.** The search stops after 300 ms, 500,000 nodes or 200 valid results.
   `exhaustive: true` means the whole tree was visited; otherwise the count is a
   lower bound and the interface says so.
5. **Variety.** Candidates are sorted by spread, then tag gaps, then squared
   deviation from the mean, then greedily thinned so each new arrangement is the
   one furthest from everything already chosen. Up to 12 are shown.
6. **Fallback.** When no valid split fits, a greedy assignment refined by
   best-swap hill climbing returns a **best effort** split, labelled as such and
   never presented as the true closest.

Tag coverage means: for every tag held by at least `N` players (enough for one
per team), count the teams with none of it. Lower is better. A tag held by fewer
players than there are teams is a specialist, never a "gap". The solver indexes
coverage against the group's own tag ids, so custom tags work exactly like the
original roles.

### Guarantees and limits

- Every arrangement uses each available player exactly once, with team sizes as
  even as possible.
- With `exhaustive: true`, the count covers every valid split at that tolerance
  (and pair rules, when set). When false, it is a lower bound.
- Win odds come from the same `expectationsFromStrengths` helper as the rating
  engine. They are elo-only: tags and damage are not part of the estimate.
- Team sums are the primary balance; tags break ties or trade within the chosen
  allowance. There is still no notion of individual matchups.
- The search is bounded, not exhaustive by construction. Large rosters with a
  loose tolerance can hit the result or time cap; the caption then reports a
  lower bound rather than claiming completeness.
- Pair rules and tag preference are session-only. Saved rounds record the teams
  and bench they produced, not the builder controls that found them.

## How the ratings work

`src/shared/elo.ts` is pure and deterministic, like the solver.

- **Scale.** 100–1000, where 100 points is one point on the 1–10 control. Creating
  a player at 1–10 sets their elo to rating × 100; the control mirrors the current
  band, and changing it snaps the elo to the new band's anchor.
- **One match, two terms.** The result term is ordinary Elo on the weighted
  rating sums, so a five-stack is favoured over a four-stack. The performance
  term is centred on zero and compares each player's share of the match's
  size-normalized damage with the share their rating predicts. It carries 0.6 of
  K while the result carries the full K. Damage is also compared with the whole
  lobby; beating more than half of everyone is a floor on the term.
- **More than two teams.** Each team is rated against every other team and the
  head-to-head expectations are normalized to share out one win, so a settled
  three-way lobby is zero-sum like a duel.
- **Uneven teams.** Damage is divided by the number of enemies faced before
  shares are compared.
- **Randoms.** An unnamed player records damage but has no rating row; their
  rating is inferred from the lobby and weighted at half a player. They are
  never updated.
- **K.** A per-group setting from 8 to 64, default 32, applying to new matches
  only. Changing it freezes the K that produced existing ratings and never
  replays the log.
- **Replay.** Ratings start at each player's creation elo (`base_elo`) and are
  recomputed from the ordered event log. Editing, reordering or deleting an event
  restores exactly the ratings history would have produced. At 1000 events the
  oldest 500 are folded into each anchor and deleted; ratings never move, but that
  history is gone.
- **Deleting players.** Removing a player archives them (`players.deleted_at`)
  rather than erasing the row, so every replay seeds them as before and nobody
  else's elo moves.

## Migrating an existing workspace

On the first `GET /api/groups`, an account that still has pre-groups rows gets a
deterministic group (`g:<sub>`) named **My roster**. Its K comes from the old
account setting, the roles the roster actually used become that group's tags
(keeping their ids), and players, events, results and legacy rounds are attached
in one batch. Running it twice cannot create a second group. A brand-new account
starts with no groups and a **Create your first group** panel.

Legacy saved rounds are readable once through `GET .../rounds`; the owner's
browser imports them into localStorage one time and marks the group as checked,
so later loads never duplicate them. Nothing writes saved rounds to the server
any more.

## Data model

```sql
groups(id TEXT PRIMARY KEY, owner_sub TEXT, owner_name TEXT, name TEXT,
       k_factor INTEGER, rev INTEGER, created_at INTEGER, updated_at INTEGER,
       deleted_at INTEGER)

group_members(group_id TEXT, user_sub TEXT, role TEXT, display_name TEXT,
              created_at INTEGER, updated_at INTEGER,
              PRIMARY KEY (group_id, user_sub))

group_invites(id TEXT PRIMARY KEY, group_id TEXT, role TEXT,
              token_hash TEXT UNIQUE, created_by_sub TEXT, created_at INTEGER,
              revoked_at INTEGER, expires_at INTEGER)

group_player_emails(group_id TEXT, player_id TEXT, email TEXT,
                    added_by_sub TEXT, created_at INTEGER,
                    PRIMARY KEY (group_id, player_id, email))

group_player_requests(id TEXT PRIMARY KEY, group_id TEXT, requester_sub TEXT,
                      requester_name TEXT, email TEXT, kind TEXT,
                      player_id TEXT, name TEXT, username TEXT, note TEXT,
                      status TEXT, decided_by_sub TEXT, decided_at INTEGER,
                      created_at INTEGER, updated_at INTEGER)

group_tags(group_id TEXT, id TEXT, label TEXT, short TEXT, sort INTEGER,
           created_at INTEGER, updated_at INTEGER,
           PRIMARY KEY (group_id, id))

players(id TEXT PRIMARY KEY, owner_sub TEXT, group_id TEXT, name TEXT,
        username TEXT, skill INTEGER, elo INTEGER, base_elo INTEGER,
        tags TEXT, sitting_out INTEGER, deleted_at INTEGER,
        created_at INTEGER, updated_at INTEGER)

rating_events(id TEXT PRIMARY KEY, owner_sub TEXT, group_id TEXT,
              position INTEGER, kind TEXT, payload TEXT,
              created_at INTEGER, updated_at INTEGER)

rating_results(event_id TEXT, owner_sub TEXT, group_id TEXT, slot TEXT,
               player_id TEXT, name TEXT, elo_before INTEGER,
               elo_after INTEGER, delta INTEGER,
               PRIMARY KEY (event_id, slot))

group_rating_meta(group_id TEXT PRIMARY KEY, legacy_k INTEGER, created_at INTEGER)
group_squashes(group_id TEXT PRIMARY KEY, removed INTEGER, squashed_at INTEGER)
rounds(id TEXT PRIMARY KEY, owner_sub TEXT, group_id TEXT, config TEXT,
       created_at INTEGER)
```

`players.tags` is a JSON array of that group's tag ids. `elo` is the live
rating, `base_elo` is the replay anchor, and `skill` is a derived mirror kept for
older readers and saved rounds. `sitting_out` remains on the table for old rows
but is no longer read or written; the API rejects it. `owner_sub` is the
creator/audit column; every route scopes by `group_id` after checking
membership. The old `settings`, `rating_meta` and `log_squashes` tables are read
only during migration.

`group_player_emails` is many-to-many on purpose: one player may be held by
several emails (alternate accounts) and one email may sit on several players.
Emails are labels, not identities — every route still authorizes on the account
`sub`, and no membership or role is ever granted by email. `group_player_requests`
holds pending claims (one per member per group); only an editor's approval touches
the roster, and an approved new player is inserted at 0 elo with no tags and the
requester's email attached.

## Guest mode vs shared

`src/client/store.ts` exposes one `Store` interface scoped to a group, with two
implementations.

| | Local (guest) | Shared (signed in) |
|---|---|---|
| Storage | `localStorage`: one device-local group | D1 through the group API |
| Header chip | "This device only" | "Synced" |
| Sharing | — | invite links with owner/editor/viewer |
| Survives reload | yes, on this browser | yes, on any device |

When a signed-in account has an empty group and this device holds a guest
roster, an import prompt copies the players in, creating any missing tags by
label first. The guest workspace keeps its own tags in localStorage; a device
that already had role tags starts with exactly those, and a fresh one starts
with none.

Sitting out, generated teams and saved rounds are always device-local. The active
group is remembered per device too.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/session` | current user, auth mode, database availability |
| GET | `/api/health` | liveness and schema state |
| GET | `/api/groups` | groups you own or belong to, with your role |
| POST | `/api/groups` | `{ name }`; 25 owned groups per account |
| GET | `/api/groups/:id` | group, tags, members and your role |
| PATCH | `/api/groups/:id` | `{ name?, kFactor? }`; editor |
| DELETE | `/api/groups/:id` | archives the group; owner |
| GET | `/api/groups/:id/rev` | revision for the live poll |
| GET | `/api/groups/:id/players` | oldest first |
| POST | `/api/groups/:id/players` | `{ name, username?, skill, tags? }` or `{ players: [...] }` |
| PATCH | `/api/groups/:id/players/:pid` | `name`, `username`, `skill`, `elo`, `tags`; never `sittingOut` |
| POST | `/api/groups/:id/players/:pid/elo` | `{ elo, reason? }`, logs an adjustment |
| DELETE | `/api/groups/:id/players/:pid` | archives the player; their history stays |
| GET | `/api/groups/:id/matches` | the ordered rating log |
| POST | `/api/groups/:id/matches` | `{ label?, teams, winner }`, 2–8 teams |
| PATCH | `/api/groups/:id/matches/:mid` | `{ input }` and/or `{ position }` |
| DELETE | `/api/groups/:id/matches/:mid` | removes the event and replays |
| GET/PUT | `/api/groups/:id/settings` | `{ kFactor }` per group, 8–64 |
| POST | `/api/groups/:id/tags` | `{ label, short? }`; up to 16 tags |
| PATCH/DELETE | `/api/groups/:id/tags/:tagId` | rename/reorder, or delete and strip |
| POST/GET | `/api/groups/:id/invites` | owner creates `{ role }` → link; lists active links |
| DELETE | `/api/groups/:id/invites/:inviteId` | revoke; owner |
| GET | `/api/groups/:id/members` | people with access |
| PATCH/DELETE | `/api/groups/:id/members/:userId` | role or removal; owner |
| GET | `/api/groups/:id/player-requests` | pending claims; editors see all, members their own |
| POST | `/api/groups/:id/player-requests` | `{ claim, note? }`; any member, viewers included |
| POST | `/api/groups/:id/player-requests/:rid/approve` | applies the claim; editor |
| DELETE | `/api/groups/:id/player-requests/:rid` | dismiss (editor) or cancel your own |
| POST | `/api/groups/:id/players/:pid/emails` | `{ email }`; editor, up to 10 per player |
| DELETE | `/api/groups/:id/players/:pid/emails/:email` | disconnect an email; editor |
| GET | `/api/invites/:token` | preview before joining, including the roster |
| POST | `/api/invites/:token/accept` | joins with the link's role; an optional `{ claim, note? }` files a request |
| GET | `/api/groups/:id/rounds` | legacy snapshots for one-time import |

Data routes answer 401 when signed out, 404 for a group you cannot see, 403 for
a write your role does not allow (or a foreign origin), 400 for invalid input,
413 above 64 KB and 503 when no database is bound.

## Tests

`bun test` runs these suites (179 tests):

- `tests/groups.test.ts` — group CRUD, invite join/preview/revoke, viewer refusal
  on every mutating route, player-claim requests (create and link, approval,
  cancellation and the 0-elo start), editor-managed emails, non-member 404s,
  cross-group isolation, owner-only sharing, tag scoping and stripping,
  device-local sit-outs, read-only legacy rounds, and idempotent migration of a
  pre-groups workspace.
- `tests/elo.test.ts` — the scale, even and uneven matches, random inference,
  deterministic replay, edit/delete/reorder, K changes, squash behaviour and
  formula compatibility.
- `tests/balance.test.ts` — team sizes, known splits, brute-force cross-checks,
  capped searches, pair rules, tag coverage ranking and sit-out suggestions.
- `tests/roles.test.ts` — the legacy catalogue, tag normalization, coverage
  (including a group's own tag ids) and custom-tag ranking.
- `tests/app.test.ts` — the real API against Miniflare D1: group-scoped CRUD,
  tags, match replay, squash, archived players, isolation and refusals.
- `tests/libsql.test.ts` — the production libSQL adapter against Bun SQLite:
  schema up/down migration, groups, tags, legacy events and squash.
- `tests/rivals-browser.test.tsx` — the real import panel in a DOM, submitting
  through the actual Worker into a group.
- `tests/connections-browser.test.tsx` — the whole player-connection journey
  through the real components: invite preview, link and new-player claims,
  joining without connecting, member-filed claims, invite-page claims where an
  account with no email types an address (both link and create, validated and
  normalised), viewer refusals, the editor review queue, cancellation and
  dismissal, and the roster's email chips.
- Plus `tests/history.test.ts`, `bench.test.ts`, `rematch.test.ts`,
  `rivals.test.ts`, `rivals-layout.test.ts`, `presentation.test.ts`,
  `pairRules.test.ts`, `store.test.ts` and `body-limit.test.ts`.

`bun run typecheck`, `bun test` and `bun run build` are the pre-deploy checks.
`bun run build:api` regenerates the committed `api/index.js` Vercel bundle.

## Deploying to Vercel

The app deploys to two hosts from one codebase. `src/worker/db.ts` defines the
small `Database` interface the routes use; Cloudflare D1 satisfies it directly,
and `src/server/libsql.ts` implements it over libSQL/Turso for Node hosts.

| Piece | Cloudflare (Sites) | Vercel |
|---|---|---|
| Browser bundle | `dist/client` | `dist-client` (`bun run build:vercel`) |
| Server | `dist/teammaker/index.js` | `api/index.ts` → a Node function |
| Database | D1 binding `DB` | libSQL over HTTP |

The Vercel function is a **committed bundle**: `bun run build:api` compiles
`server/vercel.ts` into the self-contained `api/index.js`. Vercel's Node builder
transpiles an `api/*.ts` entry without bundling it, so relative imports into
`src/` break at runtime; one file with only package imports cannot fail that way.
Run `bun run build:api` and commit `api/index.js` after changing anything under
`src/worker`, `src/server` or `server/`.

1. **Project settings** — Framework Preset **Other**, Build Command
   `bun run build:vercel`, Output Directory `dist-client`, Install Command
   `bun install`, Node **22.x**. Dashboard values win over `vercel.json`.
2. **Database** — Vercel Marketplace → Turso → install, then copy
   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. No migration step: the first
   request runs `CREATE TABLE IF NOT EXISTS` plus the column guards, including
   the group tables and `group_id` columns.
3. **Sign-in** — register the exact production origin with
   `npx @freebuff/auth register`, then set `APP_ORIGIN`, `FREEBUFF_CLIENT_ID` and
   `FREEBUFF_ISSUER` in **Production** only. Preview deployments rotate their
   domain, so leaving auth out of Preview keeps them in guest mode.
4. **Check** — `/` returns HTML, `/api/session` reports `database: true`, and a
   signed-out group route is 401.

Environment names are the same everywhere:

| Variable | Where | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL` | Vercel | libSQL connection |
| `TURSO_AUTH_TOKEN` | Vercel | libSQL token |
| `APP_ORIGIN` | Vercel / Sites | canonical origin for cookies, CSRF and invite links |
| `FREEBUFF_CLIENT_ID` / `FREEBUFF_ISSUER` | Vercel / Sites | public OIDC client |

## Publishing

Only when asked. Create or inspect the site, run `sites_add_storage` for `DB`,
run `sites_enable_auth` with the local Worker origin so sign-in works in
development, then build and deploy with `deploy.json`. Sites injects
`FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN`; no application secret
is stored in this project. Read `node_modules/@freebuff/auth/AGENTS.md` before
changing anything about sign-in.

## Current limits

- Saved rounds are capped at the newest 60 per group, per device.
- The server keeps the newest 1000 rating events per group; older ones are
  squashed into the anchors as described above, and a group's match list only
  covers the kept window.
- At most 200 players, 16 tags, 25 owned groups and 100 members per group.
- Live updates are revision-polled (~2.5 s while the tab is visible). There is
  no presence indicator, and simultaneous edits are last-write-wins.
- Invite links are multi-use until revoked; there is no expiry UI yet.
- Player requests are reviewed in the app. Nothing is emailed, and a claim stays
  pending until an editor applies or dismisses it.
- Screenshot import runs entirely in the browser and needs no extra deployment.
