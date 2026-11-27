import { expect, test } from 'bun:test'
import { syncPairRules } from '../src/client/pairRules'
import type { PairRule } from '../src/shared/balance'

const rules: PairRule[] = [
  { a: 'p0', b: 'p1', kind: 'together' },
  { a: 'p2', b: 'p3', kind: 'apart' },
]

test('benching a player drops their pair rule and reports exactly what was removed', () => {
  // p1 sits out: only the rule that named them goes.
  const one = syncPairRules(rules, ['p0', 'p2', 'p3'])
  expect(one.rules).toEqual([rules[1]!])
  expect(one.notice).toBe(
    '1 pair rule removed because a player sat out or left.',
  )

  // A second pass with the already-pruned rules stays quiet.
  expect(syncPairRules(one.rules, ['p0', 'p2', 'p3'])).toEqual({
    rules: one.rules,
    notice: '',
  })

  // Two players leave: both rules go, with the plural notice.
  const both = syncPairRules(rules, ['p0', 'p2'])
  expect(both.rules).toEqual([])
  expect(both.notice).toBe(
    '2 pair rules removed because a player sat out or left.',
  )
})

test('an unchanged lineup keeps the same rule list and shows no notice', () => {
  const result = syncPairRules(rules, ['p0', 'p1', 'p2', 'p3'])
  expect(result.rules).toBe(rules)
  expect(result.notice).toBe('')
})
