# Guest mode never loads the workspace

**Status:** proposed · **Severity:** S1 · **Confidence:** confirmed · **Effort:** S

## Problem

A signed-out visitor — the default first-run state on a hosted deployment — gets
an empty roster and rounds, plus a "Sign in to track matches" error, even though
their players are saved on the device. Every reload repeats it. The app's
"works immediately on this device" promise fails before the first interaction.

## Evidence

`src/client/App.tsx:87-90` loads all three sections in one `Promise.all`:

```ts
const [loadedPlayers, loadedRounds, loadedMatches] = await Promise.all([
  store.players(),
  store.rounds(),
  store.matches(),
])
```

For `remote === false`, `store` is the local store, and `src/client/store.ts:140`
is `matches: unsupported`, where `unsupported` rejects with
`Sign in to track matches and tune elo.` The rejection discards the resolved
players and rounds, leaves `players` at `[]`, and sets `error`.

Reproduced against the real module with an in-memory `localStorage`:

```
localStore.matches THREW: Sign in to track matches and tune elo.
```

The local store is chosen whenever there is no signed-in user or no database
(`src/client/App.tsx:56`), which includes every signed-out visitor to a hosted
build.

## Desired behaviour

- Device-only mode loads the saved roster and rounds on first paint.
- The match panel stays hidden (it already is when `remote` is false), and no
  sign-in error appears just because there is no match log.
- A failure in one section does not throw away the others.

## Approach

1. **Make the guest log truthfully empty.** `localStore.matches()` resolves
   `{ kFactor: DEFAULT_K_FACTOR, events: [] }` instead of rejecting. The local
   store has no match history by design, so an empty log is the correct answer,
   not an error. This also makes `refreshMatches()` safe if a guest path ever
   calls it (`App.tsx:117-119`).
2. **Load the sections independently.** Replace the single `Promise.all` with
   `Promise.allSettled` (or three small guarded loads), apply whichever sections
   succeeded, and surface one error for the sections that failed. A transient
   `/api/matches` failure should not blank a signed-in user's roster.

Rejected: calling `store.matches()` only when `remote` is true. It fixes the
reported repro but leaves the interface method rejecting, so the next caller
hits the same trap, and a partial remote failure still blanks the workspace.

## Changes

- `src/client/store.ts` — return the empty `MatchesResponse` from the local
  store; `DEFAULT_K_FACTOR` is already imported in this file.
- `src/client/App.tsx` — settle the three loads independently; keep `ready`
  true after they settle; do not overwrite a successful section with an empty
  one.
- `tests/store.test.ts` (new) — a Bun test with an in-memory `localStorage`
  asserting `createStore(false).matches()` resolves with `events: []` and the
  default K. The repo has no store test today.
- Optional in the same plan: a browser test in `tests/rivals-browser.test.tsx`'s
  style that renders the app in guest mode with a seeded roster and asserts the
  player is visible; this needs the session fetch mocked.

## Risks and rollback

- No data migration. Players and rounds are already stored; this only stops
  rejecting them.
- If a local match log is added later, this method must start returning it.
  A comment on the method should say so.
- The independent load changes error presentation: one message for one failed
  section rather than a single shared failure. Verify the "could not reach the
  workspace" path still appears when everything fails.

## Verification

- `bun run typecheck`
- `bun test` — the new store test fails before the change (the promise rejects)
  and passes after it.
- Manual guest check on a hosted/`setup` build: add two players, reload, confirm
  both appear with no error. Then repeat on a signed-in build to confirm the
  remote path still loads.

## Out of scope

- Local match logging or local rating history.
- Changing when the Matches panel is shown.

## Open questions

None. The empty-log behaviour matches the documented guest model.