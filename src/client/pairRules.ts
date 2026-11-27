import type { PairRule } from '../shared/balance'

export type PairRuleSync = {
  rules: PairRule[]
  notice: string
}

/**
 * Rules describe the current lineup. When one of their players sits out or
 * leaves, drop the rule and say so rather than silently pausing it.
 */
export function syncPairRules(
  rules: PairRule[],
  availableIds: Iterable<string>,
): PairRuleSync {
  const available = new Set(availableIds)
  const kept = rules.filter(
    (rule) => available.has(rule.a) && available.has(rule.b),
  )
  if (kept.length === rules.length) return { rules, notice: '' }
  const dropped = rules.length - kept.length
  return {
    rules: kept,
    notice: `${dropped} pair rule${dropped === 1 ? '' : 's'} removed because a player sat out or left.`,
  }
}
