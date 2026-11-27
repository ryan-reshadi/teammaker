# Reconcile the README with the current tree

**Status:** proposed · **Severity:** S4 · **Confidence:** confirmed · **Effort:** S

## Problem

The README has been updated for the browser OCR and the archive behaviour, but
three spots still describe files that no longer exist or omit a column the code
uses. A reader following the test inventory, the schema or the Vercel table is
sent to the wrong place.

## Evidence

- `README.md:506-510` still lists `tests/rivals-import.test.ts` and describes
  "the proxied OCR call and its bearer token". That file is deleted and the
  `/api/rivals` routes are gone; `bun test` now reports 13 files.
- `README.md:363-365` shows `players(id, owner_sub, name, skill, elo, base_elo,
  tags, sitting_out, created_at, updated_at)` without `deleted_at`, although the
  "Deleting players" bullet and `src/worker/db.ts:33,89` use it.
- `README.md:529,543,588` call the Vercel entrypoint `api/index.ts`. The repo
  contains `api/index.js`, built from `server/vercel.ts` by
  `bun run build:api`; there is no `api/index.ts`.

These are documentation-only drifts; the code and checks are consistent.

## Desired behaviour

- The test inventory matches `ls tests` (including the new
  `tests/body-limit.test.ts` and the existing `tests/rivals-browser.test.tsx`),
  with no entry for a deleted file.
- The schema block includes `deleted_at INTEGER` and the note that removal
  archives rather than erases.
- The Vercel table and the build instructions name `api/index.js` as the
  committed bundle and `server/vercel.ts` as its source.

## Approach

Edit the three spots rather than rewriting the README:

1. Replace the `tests/rivals-import.test.ts` entry with the suites that exist.
   Reconcile the whole list against `ls tests` while there; add `body-limit` and
   `rivals-browser` if they are still missing.
2. Add `deleted_at INTEGER` to the `players` schema block and keep the existing
   archive explanation.
3. Replace `api/index.ts` with `api/index.js` (and name `server/vercel.ts` as the
   source) in the table, the paragraph below it, and the build snippet.

Rejected: leaving the test entry in place with "removed" beside it. The section
is an inventory; a deleted file should not appear.

## Changes

- `README.md` only.

## Risks and rollback

- Documentation only. The main risk is introducing a new inconsistency; check
  each named path exists before committing the edit.
- No behaviour or deploy change.

## Verification

- `ls tests` matches the test inventory in the README.
- `grep -n "rivals-import\|api/index.ts" README.md` returns nothing.
- The schema block contains `deleted_at`.
- `bun test` still reports 131 pass, 0 fail.

## Out of scope

- Restructuring the README or rewriting the OCR section (already current).
- Documenting the reference Python service beyond its existing local-comparison
  note.