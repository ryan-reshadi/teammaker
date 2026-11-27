# Bound the match-log payload

**Status:** proposed · **Severity:** S3 · **Confidence:** confirmed (shape measured) · **Effort:** L, phased

## Problem

The match endpoint returns the entire log, with a before/after rating row for
every player in every event, on every load. The client also refetches all of it
after every rating edit. As an account approaches the documented 1000-event cap,
first paint and each rating change grow with total history rather than with what
the screen shows.

## Evidence

- `src/worker/app.ts:517-530`: `matchViews` loads every event and every
  `rating_results` row for the owner, then joins them in memory.
- `src/shared/elo.ts:33`: `MAX_EVENTS = 1000`. A match allows up to 8 teams of 10
  players (`MAX_MATCH_TEAMS`, `MAX_MATCH_PLAYERS`).
- `src/client/App.tsx:87-90` fetches the log on load; `App.tsx:153-154` calls
  `refreshMatches()` after every skill or elo edit, which fetches it again.
- Measured on a synthetic array using the exact response fields:
  - 1000 events × 2 teams × 10 players: **2.45 MB** of JSON
  - 1000 events × 8 teams × 10 players (the caps): **9.40 MB** of JSON

Real 5v5 logs are smaller (about 0.6 MB at 1000 events), and the hosts compress
responses, but the client still parses and retains the whole structure and the
fetch happens after each rating change.

The cross-history consumers are the reason the payload has not been windowed:
`sitOutCounts` needs every match to keep the bench fair, and the roster's
sparkline needs a player's whole history.

## Desired behaviour

- A normal match-log load stays under a fixed budget (recommend 500 KB) no
  matter how long the account has been used.
- Older history is still reachable, and player history is still complete when
  the panel is opened.
- Bench suggestions remain based on the full log, not the visible window.
- Editing one rating does not download the whole log.

## Approach

Three independently shippable phases. Phase 1 is the small, high-value fix;
phase 2 is the structural one.

### Phase 1 — stop refetching the whole log for one adjustment

`PATCH /api/players/:id` already returns the updated player. When it logs an
adjustment, also return the created `RatingEventView` (or `null` when it only
moved `base_elo`). In `App.updatePlayer`, append that event to `events` and drop
the `refreshMatches()` call for rating patches. `PATCH /api/settings` does not
change history, so it does not need a full log fetch either.

### Phase 2 — window the detail and move the aggregate to the server

- Add `limit` (default 100, max 1000) and a `before` position cursor to
  `GET /api/matches`. Keep the response shape backward compatible: `events` is
  still present, and add `total`.
- Add `bench: { counts, matchCount }`, computed from the full event log and the
  roster on the server, to the same response. `App` passes it to `Build` instead
  of deriving `sitOutCounts` from the window. When no match exists, keep the
  existing saved-round fallback.
- Show the newest window in `Matches` with a "Load older" control that requests
  the next page.
- Roster history uses the window. If an account has older events for that
  player, phase 3 fills them in.

### Phase 3 — per-player history on demand

Add `GET /api/players/:id/history` (scoped by `owner.sub`) returning that
player's match and adjustment views from `rating_results`. `Roster` fetches it
when the history panel opens. Until then, the sparkline uses the window.

Rejected: replaying the log in the browser to avoid sending results. The stored
`rating_results` are the rated source of truth, and duplicating the engine
client-side risks drift. Rejected: raising the cap or compressing only; neither
bounds parse time or memory.

## Changes

Ordered, by phase:

- `src/worker/app.ts` — return the adjustment event from player patches; add
  `limit`/`before`/`total`/`bench` to the match list; add the player-history
  route.
- `src/shared/elo.ts` — `MatchesResponse` gains `total` and `bench`; a window
  type for the client.
- `src/client/App.tsx` — append the returned adjustment; pass the server bench
  counts; load older pages.
- `src/client/components/Matches.tsx` — "Load older" and a total count.
- `src/client/components/Roster.tsx` — fetch history on panel open.
- `src/client/store.ts` — the new query parameters and history call.
- `tests/app.test.ts`, `tests/libsql.test.ts` — window boundaries, bench counts
  equal to the full-log computation, owner scoping, and the adjustment event.

## Risks and rollback

- **Bench fairness is the main risk.** A window without a server-computed bench
  would silently change who is suggested to sit. Test the aggregate against the
  current full-log implementation.
- A window is stale after an edit or delete. Re-fetch the visible page after
  mutations, or patch the window from the mutation response.
- Ordering ties: paginate by `(position, id)` consistently in the query and the
  cursor.
- Older clients must keep working: keep `events` and `kFactor` in the response
  and only add fields.
- Rollback: the server can ignore the new parameters and return the full log
  until the client change ships; phase 1 has no schema impact.

## Verification

- Seed a 1000-event account in the Miniflare/libSQL fixture; assert the default
  response is under 500 KB and that `bench.counts` equals `sitOutCounts` over
  the full log.
- Assert "load older" returns disjoint pages, newest first, with no duplicate
  event ids.
- Assert a rating patch returns the new adjustment and the client does not issue
  a `/api/matches` request.
- `bun run typecheck`, `bun test`.

## Out of scope

- Changing the event/result schema.
- Server-side analytics over the log.

## Open questions

- How much history should the log show by default? Recommend 100 events; the
  owner may prefer 200. This changes only the default, not the design.