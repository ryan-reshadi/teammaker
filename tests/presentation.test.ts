import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResultStatus } from '../src/client/components/ResultStatus'
import { describeSolveResult } from '../src/client/solvePresentation'
import {
  solve,
  type SolveResult,
  type SolverPlayer,
} from '../src/shared/balance'

const roster = (elos: number[]): SolverPlayer[] =>
  elos.map((elo, index) => ({ id: `p${index}`, name: `Player ${index}`, elo }))

/** Renders the same component Build uses, not a parallel copy of its logic. */
const renderResult = (result: SolveResult, index = 0) => {
  const shown = result.arrangements[index]!
  return renderToStaticMarkup(
    createElement(ResultStatus, {
      view: describeSolveResult(result, index),
      spread: shown.spread,
      withinTolerance: shown.withinTolerance,
      totalElo: shown.teams.reduce((sum, team) => sum + team.sum, 0),
      onWiden: () => {},
    }),
  )
}

test('an early-stopped fallback inside tolerance is still labelled best effort', () => {
  // An exact partition exists, but the node cap stops the search before it finds
  // one; the fallback happens to land on a perfect 0-spread split.
  const result = solve(
    roster([
      425, 925, 375, 650, 725, 500, 750, 750, 400, 450, 925, 325, 925, 725,
    ]),
    { teamCount: 3, tolerance: 0, maxNodes: 1, timeBudgetMs: 0 },
  )
  expect(result.exhaustive).toBe(false)
  expect(result.validCount).toBe(0)
  const shown = result.arrangements[0]
  expect(shown?.withinTolerance).toBe(true)
  expect(shown?.spread).toBe(0)

  const view = describeSolveResult(result, 0)
  expect(view.bestEffort).toBe(true)
  expect(view.notice).toContain('stopped early')
  expect(view.notice).toContain('fits the tolerance')
  expect(view.notice).toContain('not a complete result')
  expect(view.notice).not.toContain('No split fits')
  expect(view.offerTolerance).toBe(false)
  expect(view.coverage).toBeNull()

  const html = renderResult(result)
  expect(html).toContain('Best effort')
  expect(html).toContain('stopped early')
  expect(html).toContain('fits the tolerance')
  expect(html).toContain('not a complete result')
  expect(html).toContain('class="warning"')
  expect(html).not.toContain('No split fits')
  expect(html).not.toContain('Allow a spread of')
})

test('an exhaustive in-tolerance result has no best-effort marker', () => {
  const result = solve(roster([1000, 900, 800, 700, 600, 500, 400, 300]), {
    teamCount: 2,
    tolerance: 0,
  })
  expect(result.exhaustive).toBe(true)
  expect(result.validCount).toBeGreaterThan(0)
  const shown = result.arrangements[0]
  expect(shown?.withinTolerance).toBe(true)

  const view = describeSolveResult(result, 0)
  expect(view.bestEffort).toBe(false)
  expect(view.notice).toBeNull()
  expect(view.coverage).toContain('All')
  expect(view.coverage).not.toContain('lower bound')

  const html = renderResult(result)
  expect(html).toContain('Spread 0')
  expect(html).not.toContain('Best effort')
  expect(html).not.toContain('stopped early')
  expect(html).not.toContain('class="warning"')
})

test('the over-tolerance fallback keeps its warning', () => {
  const result = solve(roster([1000, 100, 100, 100]), {
    teamCount: 2,
    tolerance: 0,
  })
  expect(result.exhaustive).toBe(true)
  expect(result.validCount).toBe(0)
  const shown = result.arrangements[0]
  expect(shown?.withinTolerance).toBe(false)

  const view = describeSolveResult(result, 0)
  expect(view.bestEffort).toBe(true)
  expect(view.notice).toContain('No split fits')
  expect(view.notice).toContain('every split was checked')
  expect(view.notice).toContain('best-effort closest')
  expect(view.offerTolerance).toBe(true)

  const html = renderResult(result)
  expect(html).toContain('Best effort')
  expect(html).toContain('No split fits')
  expect(html).toContain('class="warning"')
  expect(html).toContain('Allow a spread of 900')
  expect(html).toContain('<button')
})

test('an impossible pair rule is reported instead of a violating fallback', () => {
  const result = solve(roster([500, 500]), {
    teamCount: 2,
    tolerance: 0,
    pairRules: [{ a: 'p0', b: 'p1', kind: 'together' }],
  })
  expect(result.constraintFailure).toBe(true)
  expect(result.arrangements).toHaveLength(0)

  const view = describeSolveResult(result, 0)
  expect(view.notice).toContain('No split fits')
  expect(view.notice).toContain('pair rule')
  expect(view.offerClearPairs).toBe(true)
  expect(view.offerTolerance).toBe(true)
  expect(view.bestEffort).toBe(false)
})

test('a satisfiable pair rule is named in the coverage line', () => {
  const result = solve(roster([900, 800, 700, 600]), {
    teamCount: 2,
    tolerance: 2000,
    pairRules: [{ a: 'p0', b: 'p1', kind: 'together' }],
  })
  expect(result.constraintFailure).toBe(false)
  const view = describeSolveResult(result, 0)
  expect(view.coverage).toContain('pair rule')
  expect(view.notice).toBeNull()
})
