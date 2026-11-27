# Improvements — Teammaker — 2026-11-27

## What this project is

Teammaker turns an elo-rated shooter roster into balanced teams: a single-page
React app served by a Hono Worker, with D1 on Freebuff Sites and libSQL/Turso on
Vercel, a device-local guest mode, a pure solver and rating engine, and a
screenshot importer that runs in the browser.

The critical paths are roster editing, team generation, match logging and
ratings replay, guest persistence, screenshot import, and the two deploy paths.
This pass focused on those, plus the shared modules they depend on.

## Checks run

| Command | Result |
|---|---|
| `bun run typecheck` | pass (client, Worker and browser-test configs) |
| `bun test` | 131 pass, 0 fail, 864 expects, 4.19 s across 13 files |
| `bun run build` | pass; only the expected >500 kB chunk warning for the on-demand OCR/WASM assets |
| `bun build server/vercel.ts --outfile .tmp-api/api-fresh.mjs` | pass; 1278 lines, byte-identical to the committed `api/index.js` |
| `bun run ocr:test` | not run — `ocr/` is now the local reference implementation, not a deployed service |

The test count dropped from 146 during this pass because the server-side
screenshot suite (`tests/rivals-import.test.ts`) was removed with the routes it
covered. The current run above is the final state.

## Findings

| ID | Severity | Confidence | Area | Finding | Evidence |
|---|---|---|---|---|---|
| F1 | S1 | confirmed | guest mode | Signed-out visitors get an empty workspace: the initial load calls the guest store's unsupported `matches()` inside one `Promise.all`, so the roster and rounds that did load are discarded and an error is shown. Reproduced against the real store. | `src/client/App.tsx:87-90`, `src/client/store.ts:140`; repro: `localStore.matches THREW: Sign in to track matches and tune elo.` → [plan 01](plans/01-guest-workspace-load.md) |
| F2 | S2 | confirmed | guest mode | The 1–10 rating control sends `{ skill }`, but the local store keeps the existing elo and recomputes skill from it, so a guest's rating change is silently discarded (and the UI reverts). Reproduced: skill 5/500 patched to 9 returns 5/500. | `src/client/components/Roster.tsx:298`, `src/client/store.ts:123-135`; repro output: `skill=9 patch -> 5 500` → [plan 02](plans/02-guest-rating-changes.md) |
| F3 | S3 | confirmed | match history | `GET /api/matches` returns every event with a before/after row for every player, and the client refetches it after every rating change. Synthetic logs matching the response schema measure 2.45 MB at 1000 events × 10 players and 9.40 MB at the documented maximum (1000 events × 8 teams × 10 players). | `src/worker/app.ts:517-530`, `src/shared/elo.ts:33`, `src/client/App.tsx:117-119,153-154` → [plan 03](plans/03-match-log-payload.md) |
| F4 | S3 | confirmed | roster rendering | `Roster` computes `playerHistory` for every player on every render, although the result is only shown for the one open history panel. Roster owns the add-form state, so every keystroke repeats the scan: 14.1 ms per render with 200 players and 1000 events. | `src/client/components/Roster.tsx:215-222` → [plan 04](plans/04-roster-history-render.md) |
| F5 | S4 | confirmed | docs | The README was updated for the browser OCR and the archive behaviour, but three places still describe the old tree: the test inventory names the deleted `tests/rivals-import.test.ts` and "the proxied OCR call"; the `players` schema block omits `deleted_at`; and the Vercel entrypoint is called `api/index.ts` although the repo has `api/index.js` built from `server/vercel.ts`. | `README.md:363,506-510,529,543,588`, `src/worker/db.ts:33,89` → [plan 05](plans/05-readme-inventory.md) |
| F6 | S4 | confirmed | rating versions | Editing a placement (v3) event preserves `formula: 3` but drops `places`, so the edited event silently replays with the winner term instead of its finishing order. Nothing writes v3 today, so this is latent rather than stored damage. | `src/worker/app.ts:1024-1035`, `src/shared/elo.ts:147-155` → [plan 06](plans/06-placement-edit.md) |

## Plans written

- [F1 — Guest mode never loads the workspace](plans/01-guest-workspace-load.md) — S1, small
- [F2 — Guest rating changes are discarded](plans/02-guest-rating-changes.md) — S2, small
- [F3 — Bound the match-log payload](plans/03-match-log-payload.md) — S3, large, phased
- [F4 — Stop recomputing every player's history](plans/04-roster-history-render.md) — S3, small
- [F5 — Reconcile the README with the current tree](plans/05-readme-inventory.md) — S4, small
- [F6 — Preserve places when editing a placement event](plans/06-placement-edit.md) — S4, small

## Considered and rejected

- **`Matches` `ordered.findIndex` inside the log render is O(n²).** Measured at
  1.4 ms per render for 1000 events; the real cost is dominated by the DOM, not
  the lookup. Not worth a change on its own.
- **The local roster has no 200-player cap.** The UI disables Add at 200 and the
  remote route enforces it; bulk add is the only way past the button and the
  server rejects it. Not a data risk without an account.
- **Saved-round sums are not checked against their players.** A saved round is a
  display-only snapshot, and the client builds it from the solver. Not a bug.
- **`connectDatabase`'s try/catch is unreachable** because the libSQL client is
  created lazily. Harmless defensive dead code.
- **Large build chunks.** The 10–29 MB OCR/WASM assets are dynamically imported
  by `store.scanRivals`; users who never scan do not download them.
- **`server/vercel.ts`'s `env` cache.** One object per process; Vercel
  environment variables do not change at runtime. Intentional.
- **The removed `/api/rivals` routes / OCR service drift.** Already resolved in
  the current tree: the routes, `src/worker/rivals.ts`, the OCR env fields and
  the server test suite are gone, and the README describes the browser scan.

## Backlog

These are real but not worth a full plan in this pass.

| ID | Severity | Finding | Smallest fix |
|---|---|---|---|
| B1 | S3 | Deleting a match takes effect on one click and replays ratings, with no confirmation or undo. (Removing a player now archives them, so that path is recoverable in data.) | Add a confirm step or an undo row for the match log. |
| B2 | S4 | `nextPosition` reads `MAX(position) + 1` and then inserts; two concurrent writes can share a position, leaving replay order to the id tiebreak. | Add a unique index on `(owner_sub, position)` and retry, or allocate positions atomically. |
| B3 | S4 | `draftFingerprint` is exported but never used, and its comment describes a repeat-submit guard that is not wired. | Wire it into the import submit path or delete it. |
| B4 | S4 | After an invalid screenshot type or size, the file input keeps its value, so choosing the same file again fires no change event. | Clear `inputRef.current.value` on every rejection. |
| B5 | S3 suspected | `ensureColumns` backfills `base_elo` only inside `WHERE elo = 0`. A partially applied migration (columns present, backfill missing) would leave `base_elo = 0` for rated players, and replay would clamp them to 100. | Backfill `elo` and `base_elo` independently with `WHERE … = 0`; the supported migration is transactional, so this is defensive. |

## Limits of this pass

- The worktree was being edited while this pass ran: the server screenshot
  routes and `tests/rivals-import.test.ts` were removed, the README was updated,
  and `api/index.js` was rebuilt. The findings, line references and checks above
  were re-run against the final state (131 tests, 1278-line bundle).
- Read the core paths: `src/shared/{elo,balance,bench,history}`, `src/worker/{app,db,auth,guard}`,
  `src/server/libsql.ts`, `src/client/{App,store,solverClient,rematch,pairRules}`,
  `Roster`, `Build`, `Matches`, `RivalsImport`, the configs and the test map.
  Did not read every test file or every OCR client module.
- Did not exercise the UI in a browser. F1 and F2 were reproduced against the
  real store module with an in-memory `localStorage`, not by clicking through.
- F3's sizes come from a synthetic log that matches the response schema, not
  from a real account. F4 was measured on the pure history function, before
  React's own work.
- No source code, dependencies, migrations or deploy configuration were changed.
  This report and its plans are the only new files.