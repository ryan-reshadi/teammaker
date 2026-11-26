import { expect, test } from 'bun:test'
import {
  arrangementSpread,
  solve,
  suggestSitOuts,
  teamSizes,
  type Arrangement,
  type SolverPlayer,
} from '../src/shared/balance'

const roster = (skills: number[]): SolverPlayer[] =>
  skills.map((skill, index) => ({
    id: `p${index}`,
    name: `Player ${index}`,
    skill,
  }))

const coverage = (arrangement: Arrangement) =>
  arrangement.teams.flatMap((team) => team.players.map((player) => player.id))

test('team sizes stay as even as possible', () => {
  expect(teamSizes(8, 2)).toEqual([4, 4])
  expect(teamSizes(7, 3)).toEqual([3, 2, 2])
  expect(teamSizes(5, 5)).toEqual([1, 1, 1, 1, 1])
  expect(teamSizes(9, 4)).toEqual([3, 2, 2, 2])
})

test('a perfect split is found with a tolerance of zero', () => {
  const result = solve(roster([10, 9, 8, 7, 6, 5, 4, 3]), {
    teamCount: 2,
    tolerance: 0,
  })
  expect(result.arrangements.length).toBeGreaterThan(0)
  expect(result.arrangements[0]!.spread).toBe(0)
  expect(result.arrangements[0]!.withinTolerance).toBe(true)
  expect(result.exhaustive).toBe(true)
  expect(result.totalSkill).toBe(52)
})

test('every valid split is counted and each player appears exactly once', () => {
  const players = roster([5, 5, 5, 5, 5, 5])
  const result = solve(players, { teamCount: 3, tolerance: 0 })

  // 6 players into 3 teams of 2: 6!/(2!^3 · 3!) = 15 distinct partitions.
  expect(result.validCount).toBe(15)
  expect(result.exhaustive).toBe(true)
  expect(result.arrangements.length).toBe(12)
  for (const arrangement of result.arrangements) {
    expect(arrangement.spread).toBe(0)
    const ids = coverage(arrangement).sort()
    expect(ids).toEqual(players.map((player) => player.id).sort())
    for (const team of arrangement.teams) expect(team.players).toHaveLength(2)
  }
  // The page shows genuinely different teams, not reshuffles of the same split.
  const keys = result.arrangements.map((arrangement) =>
    arrangement.teams.map((team) => [...team.players.map((p) => p.id)].sort().join('+')).sort().join('|'),
  )
  expect(new Set(keys).size).toBe(keys.length)
})

test('the bound-based search agrees with brute force on a small roster', () => {
  const skills = [9, 8, 7, 6, 5, 4, 3, 2]
  const players = roster(skills)
  const total = skills.reduce((sum, skill) => sum + skill, 0)

  for (const tolerance of [0, 1, 2, 3, 5]) {
    // Team 0 always holds the best player in canonical order, so every split is
    // one 4-subset of the remaining players.
    let expected = 0
    for (let mask = 0; mask < 1 << 7; mask++) {
      const team = [skills[0]!]
      for (let bit = 0; bit < 7; bit++)
        if (mask & (1 << bit)) team.push(skills[bit + 1]!)
      if (team.length !== 4) continue
      const sum = team.reduce((value, skill) => value + skill, 0)
      if (Math.abs(sum - (total - sum)) <= tolerance) expected++
    }
    const result = solve(players, {
      teamCount: 2,
      tolerance,
      maxResults: 500,
      timeBudgetMs: 5000,
      maxNodes: 2_000_000,
    })
    expect({ tolerance, count: result.validCount }).toEqual({ tolerance, count: expected })
    expect(result.exhaustive).toBe(true)
  }
})

test('uneven team sizes are complete: strong players may stand alone', () => {
  const players = roster([9, 9, 8, 8, 7, 7, 6, 6, 5, 4, 3])
  const result = solve(players, {
    teamCount: 8,
    tolerance: 4,
    timeBudgetMs: 5000,
    maxNodes: 2_000_000,
  })
  expect(result.validCount).toBeGreaterThan(0)
  expect(result.exhaustive).toBe(true)
  const best = result.arrangements[0]!
  expect(best.spread).toBe(4)
  expect(best.withinTolerance).toBe(true)
  // Three teams of two, five of one.
  expect(best.teams.map((team) => team.players.length).sort()).toEqual([
    1, 1, 1, 1, 1, 2, 2, 2,
  ])
  // The two best players are not forced into the pair teams.
  expect(coverage(best).sort()).toEqual(players.map((player) => player.id).sort())
})

test('uneven sizes agree with brute force on a five-player roster', () => {
  const skills = [9, 7, 5, 3, 1]
  const players = roster(skills)
  const total = skills.reduce((sum, skill) => sum + skill, 0)
  for (const tolerance of [0, 1, 2, 3, 4, 6]) {
    // Teams of 3 and 2: every partition is one choice of the two-player team.
    let expected = 0
    for (let a = 0; a < skills.length; a++) {
      for (let b = a + 1; b < skills.length; b++) {
        const small = skills[a]! + skills[b]!
        if (Math.abs(small - (total - small)) <= tolerance) expected++
      }
    }
    const result = solve(players, {
      teamCount: 2,
      tolerance,
      maxResults: 500,
      timeBudgetMs: 5000,
      maxNodes: 2_000_000,
    })
    expect({ tolerance, count: result.validCount }).toEqual({
      tolerance,
      count: expected,
    })
    expect(result.exhaustive).toBe(true)
  }
})

test('impossible tolerances fall back to the closest achievable split', () => {
  const result = solve(roster([10, 1, 1, 1]), { teamCount: 2, tolerance: 0 })
  expect(result.validCount).toBe(0)
  expect(result.arrangements).toHaveLength(1)
  const best = result.arrangements[0]!
  expect(best.withinTolerance).toBe(false)
  // Two teams of two: every split is {10,1} against {1,1}.
  expect(best.spread).toBe(9)
  expect(arrangementSpread(best.teams)).toBe(9)
  // The search itself finished: there is genuinely no split inside the tolerance.
  expect(result.exhaustive).toBe(true)
})

test('uneven rosters still place everyone on exactly one team', () => {
  const players = roster([10, 9, 8, 4, 3])
  const result = solve(players, { teamCount: 2, tolerance: 20 })
  expect(result.arrangements.length).toBeGreaterThan(0)
  for (const arrangement of result.arrangements) {
    expect(coverage(arrangement).sort()).toEqual(
      players.map((player) => player.id).sort(),
    )
    expect(
      arrangement.teams.map((team) => team.players.length).sort(),
    ).toEqual([2, 3])
  }
})

test('a fallback inside the tolerance is not labelled as over it', () => {
  // 11 players into 8 teams can only reach a spread of 4, which fits a
  // tolerance of 4 and must not be reported as a failed search.
  const players = roster([9, 9, 8, 8, 7, 7, 6, 6, 5, 4, 3])
  const impossible = solve(players, { teamCount: 8, tolerance: 3 })
  expect(impossible.arrangements[0]!.withinTolerance).toBe(false)
  expect(impossible.arrangements[0]!.spread).toBe(4)
  const reachable = solve(players, { teamCount: 8, tolerance: 4 })
  expect(reachable.arrangements[0]!.withinTolerance).toBe(true)
  expect(reachable.arrangements[0]!.spread).toBe(4)
})

test('a short budget stops early but still returns usable teams', () => {
  const players = roster([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 9, 8, 7, 6, 5, 4])
  const result = solve(players, {
    teamCount: 4,
    tolerance: 0,
    maxNodes: 1,
    timeBudgetMs: 0,
    maxResults: 2,
  })
  expect(result.exhaustive).toBe(false)
  expect(result.arrangements.length).toBeGreaterThan(0)
  expect(result.arrangements[0]!.teams).toHaveLength(4)
  expect(coverage(result.arrangements[0]!).sort()).toEqual(
    players.map((player) => player.id).sort(),
  )
})

test('sit-out suggestions bench the fairest, weakest players first', () => {
  const players = [
    { id: 'a', skill: 9, sittingOut: false },
    { id: 'b', skill: 4, sittingOut: false },
    { id: 'c', skill: 6, sittingOut: false },
    { id: 'd', skill: 3, sittingOut: false },
    { id: 'e', skill: 10, sittingOut: true },
    { id: 'f', skill: 7, sittingOut: false },
    { id: 'g', skill: 2, sittingOut: false },
    { id: 'h', skill: 5, sittingOut: false },
  ]
  // Seven available across three teams leaves one on the bench: weakest first.
  expect(suggestSitOuts(players, 3, {})).toEqual(['g'])
  // Someone who has already sat gives way to the weakest player who has not.
  expect(suggestSitOuts(players, 3, { g: 3 })).toEqual(['d'])
  expect(suggestSitOuts(players, 3, { g: 3, d: 2, b: 1 })).toEqual(['h'])
  expect(suggestSitOuts(players, 2, {})).toEqual(['g'])
  expect(suggestSitOuts(players.slice(0, 7), 3, {})).toEqual([])
})

test('sitting-out players are only ever excluded by the caller', () => {
  const players = roster([9, 9, 1, 1])
  const available = players.filter((player) => player.id !== 'p2' && player.id !== 'p3')
  const result = solve(available, { teamCount: 2, tolerance: 0 })
  expect(result.playerCount).toBe(2)
  expect(result.arrangements[0]!.spread).toBe(0)
  expect(coverage(result.arrangements[0]!).sort()).toEqual(['p0', 'p1'])
})
