# Preserve places when editing a placement event

**Status:** proposed · **Severity:** S4 · **Confidence:** confirmed · **Effort:** S

## Problem

Editing a placement-rated (v3) match keeps its formula marker but drops the
finishing order. The edited event then replays with the winner term instead of
the placement term, silently changing how the match scores. The event log's
contract is that editing never re-rates an event; this breaks it for v3.

Nothing writes v3 today — `PLACEMENT_FORMULA` is read-only and no route stamps
it — so no stored account is currently affected. The defect is latent for a
future placement feature or an imported v3 log.

## Evidence

`src/worker/app.ts:1024-1035` preserves only the formula and K:

```ts
let marker: { formula?: 2 | 3 | 4; k?: number } = {}
const version = eventFormula(existing)
if (version !== 1) {
  marker = { formula: version }
  if (isKFactor(existing.k)) marker.k = existing.k
}
const nextInput: MatchInput = { ...input, ...marker }
```

`src/shared/elo.ts:147-155` returns 3 for a v3 payload, and `rateMatch` only uses
`input.places` when `formula === PLACEMENT_FORMULA && isPlacement(...)` (see
`rateMatch`'s `placed` calculation in the same file). Without `places`, a v3
event falls back to the winner flag.

## Desired behaviour

- Editing a v3 event with the same number of teams keeps its `places` and rates
  the same way.
- If the edit changes the team count (so the old places no longer describe the
  field), reject the edit with a clear 400 instead of silently downgrading it.
- v1 and v2 events keep their current behaviour.

## Approach

Extend the preserved marker with `places`:

```ts
let marker: { formula?: 2 | 3 | 4; k?: number; places?: number[] } = {}
// ...
if (version === PLACEMENT_FORMULA) {
  if (
    !isPlacement(existing.places, existing.teams.length) ||
    input.teams.length !== existing.teams.length
  ) {
    return c.json({ error: 'Editing a placement match cannot change the number of teams.' }, 400)
  }
  marker.places = existing.places
}
```

Import `PLACEMENT_FORMULA` and `isPlacement` from `../shared/elo`. Rejected:
converting the edited event to v4. That upgrades the formula and violates the
"editing never upgrades" rule; the event would no longer replay as it was rated.

## Changes

- `src/worker/app.ts` — the marker block in `PATCH /api/matches/:id`.
- `tests/elo.test.ts` or `tests/app.test.ts` — a v3 fixture with `places`, an
  edit that changes only the label, and an assertion that the stored payload
  still carries `places` and the replay result is unchanged. A second case
  changes the team count and expects 400.

## Risks and rollback

- If a v3 event has malformed places, the edit is rejected rather than repaired.
  That is safer than guessing a finishing order; the alternative is to require
  the caller to resubmit the match as v4.
- No schema change, no stored data rewritten. Revert is the marker block.
- v3 remains unwritable; this only protects imported or future events.

## Verification

- `bun test` — the new v3 edit case fails before the change (places missing
  after the edit) and passes after it.
- `bun run typecheck`.

## Out of scope

- Adding a writer for v3 placement events.
- Changing how placements are derived from scores.