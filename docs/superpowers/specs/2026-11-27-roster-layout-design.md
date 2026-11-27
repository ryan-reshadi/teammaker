# Roster layout: roomy rows and a readable rename editor

**Date:** 2026-11-27
**Status:** implemented

## Why

The roster is the app's editing surface, but each player is a single line carrying
controls: name, elo badge, rating-history arrow, ten rating ticks, "Sit out" and
`×`. (The provisional `P` badge has since been retired with the flat-K change, so
the roster no longer shows it; the layout below is otherwise current.) The panel
is capped at 400px and the name is the only flexible column, so it collapses to
roughly 70px and every name truncates (`A...`, `T... Bu...`, `Mink...`). Renaming is worse: the name and username inputs
are forced into that same 70px column, so you cannot read what you are typing.

## Goals

- Names and usernames are readable at the current 400px column width.
- The rename editor gets comfortable, full-width inputs.
- Every existing roster feature keeps working exactly as it does today.
- The page keeps its two-column structure.

## Non-goals

- No new roster features (search, sorting, grouping, bulk edit).
- No changes to the server, store, elo engine or API.
- No restyling of Build, Matches, History or the header.

## Anti-goals

- A layout that only looks better on a wide viewport but still truncates names at
  400px.
- Rows so tall that a normal 8–12 player roster becomes a long scroll.

## Constraints

- React plus the single `src/client/style.css`; no new dependencies.
- Every control stays keyboard-reachable with its current labels and titles.
- The `max-width: 560px` breakpoint must keep working (ticks stretch, controls
  wrap).

## Approaches

**A. Stacked rows with a full-width editor (chosen).** Each player becomes a small
card: identity on its own line, the rating control on the next line with the
exact elo beside it, then roles and actions. The rename editor takes the identity
line at full width.

**B. Full-width roster table above Build.** The most room, but Build and Saved
rounds move below the roster and the page changes shape. Rejected: the request is
for breathing room, not a different page.

**C. Widen the column to ~480px.** Smallest change, but still six controls on one
line and names gain only ~40px. Rejected: it leaves the rename editor cramped.

## The design

Markup in `src/client/components/Roster.tsx`:

```
<li class="player-row">
  <div class="player-main">        ← line 1, full width
    name button (name, then username underneath)  |  details editor
  </div>
  <div class="player-rating">      ← line 2, full width
    rating ticks + value            ...            elo badge · history arrow
  </div>
  <div class="player-foot">        ← line 3, wraps
    role chips                     ...            sit-out toggle · remove
  </div>
  history panel (when open, full width)
</li>
```

Sketch:

```
Ada Lovelace
ada#1
▮▮▮▮▮▯▯▯▯▯ 5                     [500] ↗
Sniper IGL                   [Sit out]  ×
```

- Line 1 holds only the identity, so the name and username get the full ~350px;
  the username sits under the name in muted text rather than as a truncated chip
  beside it.
- Line 2 is the rating on its own line, with the exact elo and the history arrow
  aligned right. The ticks can grow into the freed width
  instead of being 6px slivers.
- Line 3 carries the role chips (left) and sit-out plus remove (right).
- `.player-details-editor` replaces line 1 with the two inputs stacked at full
  row width (~350px), Save/Cancel beneath, and the rating line stays visible
  directly under it.
- `.player-roles` keeps block flow; the expanded role picker still spans the row.
- The rest is CSS: `.player-row` becomes a vertical grid (`gap: 6px`,
  `padding: 12px 0`), and the old five-column `grid-template-columns` rules —
  including the `560px` override — are replaced by the stacked lines.

## Tradeoff

Rows go from about 72px to about 115px, so a nine-player roster is roughly 400px
taller. That is the cost of each control having its own room; the roster is the
editing surface, so the trade is worth it. If it feels too tall, the role line
can fold back into the rating line for players with no roles.

## Decided by the user

- Approach A over B and C.
- The rating control goes on its own line under the name and the editor, not
  beside them.

## My calls

- Keep the 400px column cap. The stacked layout earns the room, and Build keeps
  its width.
- Move the exact elo badge and the history arrow down to the rating line, so all
  the rating information reads together.
- Put the username under the name rather than beside it.
- Move sit-out and remove to the bottom-right of the row, away from the name.

## What's left to the builder

Implement the markup and CSS, then verify typecheck, the test suite, and the
rendered roster at desktop and mobile widths.
