import { expect, test } from 'bun:test'
import { solve, type SolverPlayer } from '../src/shared/balance'
import {
  normalizeTags,
  roleCoverage,
  roleGapScore,
  roleLabel,
  roleMask,
  ROLES,
} from '../src/shared/roles'

const player = (id: string, tags: string[], skill = 5): SolverPlayer => ({
  id,
  name: id,
  skill,
  tags,
})

test('the catalogue covers the common shooter roles with stable ids', () => {
  expect(ROLES.map((role) => role.id)).toEqual([
    'sniper',
    'push',
    'antipush',
    'entry',
    'support',
    'flank',
    'igl',
    'flex',
  ])
  expect(roleLabel('antipush')).toBe('Anti-push')
  expect(new Set(ROLES.map((role) => role.short)).size).toBe(ROLES.length)
})

test('normalizeTags drops unknowns and duplicates, keeping catalogue order', () => {
  expect(normalizeTags(['sniper', 'igl'])).toEqual(['sniper', 'igl'])
  expect(normalizeTags(['igl', 'sniper', 'sniper'])).toEqual(['sniper', 'igl'])
  expect(normalizeTags(['wizard', 'sniper'])).toEqual(['sniper'])
  expect(normalizeTags(undefined)).toEqual([])
  expect(normalizeTags('sniper')).toEqual([])
  expect(normalizeTags([1, 'push'])).toEqual(['push'])
})

test('role masks pack multiple roles into one number', () => {
  const both = roleMask(['sniper', 'igl'])
  expect(both).toBe(roleMask(['igl', 'sniper']))
  expect(both & roleMask(['sniper'])).toBe(roleMask(['sniper']))
  expect(roleMask([])).toBe(0)
})

test('coverage reports gaps only for roles at least one team could have', () => {
  const shared = roleCoverage([
    { players: [player('a', ['sniper']), player('b', [])] },
    { players: [player('c', ['sniper']), player('d', [])] },
  ])
  expect(shared.missing).toEqual([])
  expect(shared.totals).toEqual({ sniper: 2 })

  const lopsided = roleCoverage([
    { players: [player('a', ['sniper']), player('b', ['sniper'])] },
    { players: [player('c', []), player('d', [])] },
  ])
  expect(lopsided.missing).toEqual([{ teamIndex: 1, role: 'sniper' }])
  expect(roleGapScore(lopsided2())).toBe(0)

  // A specialist role held by a single player is not a gap.
  const specialist = roleCoverage([
    { players: [player('a', ['igl'])] },
    { players: [player('b', [])] },
  ])
  expect(specialist.missing).toEqual([])
})

function lopsided2() {
  return [
    { players: [player('a', ['igl'])] },
    { players: [player('b', ['igl'])] },
  ]
}

test('roles break ties between equally balanced splits', () => {
  // 6 players at skill 5: every split has spread 0, so roles decide the order.
  const players = [
    player('s1', ['sniper']),
    player('s2', ['sniper']),
    player('s3', ['sniper']),
    player('a1', ['antipush']),
    player('a2', ['antipush']),
    player('a3', ['antipush']),
  ]
  const result = solve(players, { teamCount: 3, tolerance: 0 })
  expect(result.arrangements.length).toBeGreaterThan(0)
  for (const arrangement of result.arrangements) {
    expect(arrangement.spread).toBe(0)
  }
  expect(roleCoverage(result.arrangements[0]!.teams).missing).toEqual([])
  // Every team got exactly one sniper and one anti-push.
  for (const team of result.arrangements[0]!.teams) {
    expect(roleCoverage([team]).counts[0]).toEqual({ sniper: 1, antipush: 1 })
  }
})

test('turning role spreading off leaves the balance ranking intact', () => {
  const players = [
    player('s1', ['sniper'], 9),
    player('s2', ['sniper'], 3),
    player('a1', ['antipush'], 8),
    player('a2', ['antipush'], 4),
  ]
  const withRoles = solve(players, { teamCount: 2, tolerance: 0 })
  const without = solve(players, { teamCount: 2, tolerance: 0, spreadRoles: false })
  expect(withRoles.arrangements[0]!.spread).toBe(0)
  expect(without.arrangements[0]!.spread).toBe(0)
  expect(withRoles.validCount).toBe(without.validCount)
  const composition = (teams: { players: { id: string }[] }[]) =>
    teams
      .map((team) => team.players.map((entry) => entry.id).sort().join('+'))
      .sort()
      .join('|')
  // Only one split fits these sums, so roles may not change it — and must not
  // break it.
  expect(composition(withRoles.arrangements[0]!.teams)).toBe(
    composition(without.arrangements[0]!.teams),
  )
  // Here the sums force two snipers against two anti-push players. That is a
  // real gap and is reported rather than hidden.
  expect(roleCoverage(withRoles.arrangements[0]!.teams).missing).toHaveLength(2)
})

test('a player can hold several roles at once and counts for each', () => {
  const result = solve(
    [
      player('x', ['sniper', 'igl']),
      player('y', ['antipush']),
      player('z', ['push']),
      player('w', ['support']),
    ],
    { teamCount: 2, tolerance: 10 },
  )
  const flat: Record<string, number> = {}
  for (const team of result.arrangements[0]!.teams)
    for (const [role, count] of Object.entries(roleCoverage([team]).counts[0]!))
      flat[role] = (flat[role] ?? 0) + count
  expect(flat).toMatchObject({ sniper: 1, igl: 1, antipush: 1, push: 1, support: 1 })
})
