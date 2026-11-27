import type { SolveResult } from '../shared/balance'

export type SolvePresentation = {
  /** True when the shown arrangement came from the best-effort fallback. */
  bestEffort: boolean
  /** Caption describing how complete the valid-split count is, or null. */
  coverage: string | null
  /** Warning or explanation to show, or null for a normal result. */
  notice: string | null
  /** True when the notice should offer widening the tolerance to the spread. */
  offerTolerance: boolean
  /** True when a failed pair-rule search can offer clearing the rules. */
  offerClearPairs: boolean
}

function coverageText(result: SolveResult): string | null {
  if (result.validCount === 0) return null
  const shown = result.arrangements.length
  const word = result.validCount === 1 ? 'split' : 'splits'
  if (result.pairRules > 0) {
    const suffix = ` satisfying your pair rule${result.pairRules === 1 ? '' : 's'}`
    if (!result.exhaustive)
      return `At least ${result.validCount} valid ${word}${suffix} — the search stopped early, so the count is a lower bound. Showing the ${shown} most different found so far.`
    if (result.validCount > shown)
      return `All ${result.validCount} valid ${word}${suffix} — showing ${shown} of the most different.`
    return `All ${result.validCount} valid ${word}${suffix} shown.`
  }
  const splits = `${result.validCount} valid ${word}`
  const verb = result.validCount === 1 ? 'fits' : 'fit'
  if (!result.exhaustive)
    return `At least ${splits} ${verb} — the search stopped early, so the count is a lower bound. Showing the ${shown} most different found so far.`
  if (result.validCount > shown)
    return `All ${splits} ${verb} — showing ${shown} of the most different.`
  return `All ${splits} shown.`
}

/**
 * Every fallback is labelled best effort. Only an exhaustive search may say no
 * split fits, and an early-stopped fallback that happens to fit is explained as
 * incomplete rather than presented like a normal arrangement.
 */
export function describeSolveResult(
  result: SolveResult,
  index: number,
): SolvePresentation {
  const arrangement = result.arrangements[index]
  const bestEffort = Boolean(arrangement) && result.validCount === 0
  let notice: string | null = null
  let offerTolerance = false
  let offerClearPairs = false

  if (!arrangement && result.constraintFailure) {
    const rules = `${result.pairRules} pair rule${result.pairRules === 1 ? '' : 's'}`
    notice = result.exhaustive
      ? `No split fits a spread of ${result.tolerance} and your ${rules}: every split was checked.`
      : `The search stopped early before finding a split within ${result.tolerance} that matches your ${rules}. Try again or clear the pair rules.`
    offerTolerance = true
    offerClearPairs = true
  } else if (arrangement && bestEffort) {
    if (result.exhaustive) {
      if (arrangement.withinTolerance) {
        notice =
          'Best-effort split from a search that checked every split. It fits the tolerance, but it is not a normal complete result.'
      } else {
        notice = `No split fits a spread of ${result.tolerance}: every split was checked. The best-effort closest split found is ${arrangement.spread}.`
        offerTolerance = true
      }
    } else if (arrangement.withinTolerance) {
      notice =
        'Best-effort split from a search that stopped early — this split fits the tolerance, but the search did not finish and this is not a complete result.'
    } else {
      notice = `The search stopped early before finding a split within ${result.tolerance}. The best-effort closest split it found is ${arrangement.spread}.`
      offerTolerance = true
    }
  }

  return {
    bestEffort,
    coverage: coverageText(result),
    notice,
    offerTolerance,
    offerClearPairs,
  }
}
