# Guest rating changes are discarded

**Status:** proposed · **Severity:** S2 · **Confidence:** confirmed · **Effort:** S

## Problem

In device-only mode, moving a player's 1–10 rating does nothing. The optimistic
UI shows the new band for a moment, then the store's response reverts it. The
same action on a signed-in account works, so the two modes disagree on a core
roster control.

## Evidence

`src/client/components/Roster.tsx:298` sends a skill-only patch:

```ts
if (skill !== band) void onUpdate(player.id, { skill })
```

`src/client/store.ts:123-135` spreads the patch over the current player and
passes it through `withElo` (`store.ts:76-82`), which keeps any finite `elo` and
recomputes `skill` from that elo. The patch's skill therefore never reaches the
stored value.

Reproduced against `createStore(false)`:

```
created: 5 500
after skill=9 patch: 5 500
after reload: 5 500
```

The remote route does the opposite: `PATCH /api/players/:id` converts a skill
patch to `skill * 100` (`src/worker/app.ts:757-768`). `App.applyPatch`
(`App.tsx:31-40`) also treats skill as authoritative while the request is in
flight, which is why the revert is visible.

## Desired behaviour

A guest skill patch sets `elo = clampElo(skill * 100)` and `skill =
skillFromElo(elo)`, persists both, and returns the updated player. A guest elo
patch still wins if both are supplied, matching the client's optimistic order.

## Approach

Mirror the remote conversion inside the local `updatePlayer`:

1. Build the next player from the current one and the patch.
2. If `patch.elo` is present, clamp it and derive skill (today's behaviour).
3. Else if `patch.skill` is present, derive `elo = eloFromSkill(patch.skill)` and
   `skill = skillFromElo(elo)`.
4. Persist and return it.

`eloFromSkill` and `skillFromElo` are already imported in `store.ts`.
Rejected: changing Roster to send both `{ skill, elo }`. That duplicates the
conversion in the UI and still leaves the store unable to handle a skill patch,
which is its documented public shape.

## Changes

- `src/client/store.ts` — the conversion in `localStore.updatePlayer`.
- `tests/store.test.ts` (new, shared with plan 01) — cases:
  - skill 5 at 500, patch skill 9 → 9 / 900, and a reload returns the same.
  - elo 512, patch elo 600 → skill 6 / 600.
  - name or sittingOut patches leave elo and skill untouched.
  - both `skill` and `elo` present → elo wins.

## Risks and rollback

- A guest with a non-anchor elo (for example 512) who touches the 1–10 control
  now snaps to the band anchor (600 for skill 6). That is the documented remote
  behaviour: "changing it snaps the elo to the new band's anchor."
- No stored data is migrated. Existing device rosters keep their elo until the
  control is used.
- Rollback is the one method body; no schema or API change.

## Verification

- `bun test` — the new store cases fail before the change (the skill stays 5)
  and pass after it.
- `bun run typecheck`
- Manual guest check: change a rating, reload, confirm the band and the exact elo
  badge both survive.

## Out of scope

- Logging a manual adjustment for guests (there is no local match log).
- The remote route, which already behaves correctly.