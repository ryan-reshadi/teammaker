# Stop recomputing every player's history

**Status:** proposed · **Severity:** S3 · **Confidence:** confirmed · **Effort:** S

## Problem

The roster derives every player's rating history on every render, even though
only the open history panel displays it. Because the Roster owns the add-player
form state, each keystroke in "Add a player" repeats the full scan. At the
documented caps this costs about 14 ms per keystroke before React's own work,
which is enough to feel like jank on a large account.

## Evidence

`src/client/components/Roster.tsx:214-222`, inside `players.map`:

```ts
const history = playerHistory(events, player.id)
const trend =
  history.length > 0
    ? [history[0]!.eloBefore, ...history.map((entry) => entry.eloAfter)]
    : [player.elo]
```

Both values are used only inside `historyFor === player.id` (the panel and its
sparkline). `playerHistory` scans every event and every team for the player
(`src/shared/history.ts:19-58`).

Measured with `bun` on the pure function, 200 players × 1000 events:

```
playerHistory for 200 players x 1000 events, x10: 141.3 ms total
per render: 14.1 ms
```

The caps allow exactly that shape: 200 players (`ROSTER_LIMIT`) and 1000 events
(`MAX_EVENTS`). Typing in the add form re-renders the Roster because `draftName`
is local state.

## Desired behaviour

- Rendering the list costs nothing per player beyond its own fields.
- Opening one player's history computes that player's history once.
- The panel, sparkline, empty state and delta columns look and behave the same.

## Approach

Gate the computation on the open panel:

```ts
const history =
  historyFor === player.id ? playerHistory(events, player.id) : []
```

and move the `trend` calculation inside the same branch. No other row needs the
value today. If a later feature needs a per-row summary, compute a `Map` once
with `useMemo` keyed by `events`, rather than per row.

Rejected: memoizing per player with a `Map` now. It is more state for no visible
gain; the open panel already gives the right granularity.

## Changes

- `src/client/components/Roster.tsx` — move `history` and `trend` into the
  `historyFor === player.id` branch (or compute them conditionally at the top of
  the row).

## Risks and rollback

- The sparkline and the "No rated matches yet" state must still render for the
  open player. The conditional keeps both in the same branch.
- No data or API change; revert is the same small edit.

## Verification

- `bun test` — the existing browser and presentation suites still pass.
- Re-run the 200 × 1000 measurement with the new shape; the per-keystroke cost
  with no panel open should drop to approximately zero.
- Manual: open a player's history with a long log and confirm the list and
  sparkline are unchanged.

## Out of scope

- Virtualizing the roster list.
- Changing the history panel's design.