import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_K_FACTOR,
  ELO_MAX,
  ELO_MIN,
  clampElo,
  eloFromSkill,
  estimateRandomElo,
  isKFactor,
  rateMatch,
  replay,
  skillFromElo,
  type MatchInput,
  type RatingEvent,
} from '../src/shared/elo'

const match = (
  teams: { elo: number; damage: number; tracked?: boolean; name?: string }[][],
  winner = 0,
): { input: MatchInput; ratings: Map<string, number> } => {
  const ratings = new Map<string, number>()
  const input: MatchInput = {
    label: '',
    winner,
    teams: teams.map((team) => ({
      players: team.map((player) => {
        const id = player.name ?? `p${ratings.size}`
        if (player.tracked !== false) ratings.set(id, player.elo)
        return {
          id,
          name: id,
          damage: player.damage,
          tracked: player.tracked !== false,
        }
      }),
    })),
  }
  return { input, ratings }
}

describe('the elo scale', () => {
  test('100 points is one point on the 1-10 control', () => {
    expect(skillFromElo(100)).toBe(1)
    expect(skillFromElo(149)).toBe(1)
    expect(skillFromElo(150)).toBe(2)
    expect(skillFromElo(749)).toBe(7)
    expect(skillFromElo(750)).toBe(8)
    expect(skillFromElo(1000)).toBe(10)
    expect(eloFromSkill(1)).toBe(100)
    expect(eloFromSkill(7)).toBe(700)
    expect(eloFromSkill(10)).toBe(1000)
  })

  test('ratings clamp to the scale and K keeps its documented range', () => {
    expect(clampElo(50)).toBe(ELO_MIN)
    expect(clampElo(1200)).toBe(ELO_MAX)
    expect(clampElo(783.4)).toBe(783)
    expect(isKFactor(8)).toBe(true)
    expect(isKFactor(64)).toBe(true)
    expect(isKFactor(7)).toBe(false)
    expect(isKFactor(65)).toBe(false)
    expect(isKFactor(32.5)).toBe(false)
    expect(DEFAULT_K_FACTOR).toBe(32)
  })
})

describe('a single match', () => {
  test('an even match moves the winners up and the losers down by the same amount', () => {
    const { input, ratings } = match([
      [
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
      ],
      [
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
      ],
    ])
    const { result, updates } = rateMatch(input, ratings, 32)
    expect(updates.get('p0')).toBe(516)
    expect(updates.get('p1')).toBe(516)
    expect(updates.get('p2')).toBe(484)
    expect(updates.get('p3')).toBe(484)
    expect(result.expected[0]).toBeCloseTo(0.5, 5)
    expect(result.teams[0]!.players[0]!.delta).toBe(16)
  })

  test('the top performer on the losing team nets close to nothing', () => {
    const { input, ratings } = match([
      [
        { elo: 500, damage: 150 },
        { elo: 500, damage: 150 },
        { elo: 500, damage: 150 },
        { elo: 500, damage: 150 },
      ],
      [
        { elo: 500, damage: 400 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
      ],
    ])
    const { result } = rateMatch(input, ratings, 32)
    const carry = result.teams[1]!.players[0]!
    const others = result.teams[1]!.players.slice(1)
    expect(carry.delta).toBeGreaterThanOrEqual(-2)
    expect(carry.delta).toBeLessThanOrEqual(3)
    for (const player of others) expect(carry.delta).toBeGreaterThan(player.delta)
    // The rest of the losing team still pays for the loss.
    expect(others[0]!.delta).toBeLessThan(-10)
  })

  test('the worst performer on the losing team pays the full result swing', () => {
    const { input, ratings } = match([
      [
        { elo: 500, damage: 150 },
        { elo: 500, damage: 150 },
      ],
      [
        { elo: 500, damage: 300 },
        { elo: 500, damage: 0 },
      ],
    ])
    const { result } = rateMatch(input, ratings, 32)
    expect(result.teams[1]!.players[1]!.delta).toBeLessThan(-30)
    expect(result.teams[1]!.players[0]!.delta).toBeGreaterThan(-3)
  })

  test('uneven teams are normalized by the enemies each player faced', () => {
    // Four players face five enemies, so 125 damage is the same rate as 100
    // against four. Every player in a team therefore has the same performance.
    const { input, ratings } = match(
      [
        [
          { elo: 500, damage: 125 },
          { elo: 500, damage: 125 },
          { elo: 500, damage: 125 },
          { elo: 500, damage: 125 },
        ],
        [
          { elo: 500, damage: 100 },
          { elo: 500, damage: 100 },
          { elo: 500, damage: 100 },
          { elo: 500, damage: 100 },
          { elo: 500, damage: 100 },
        ],
      ],
      0,
    )
    const { result } = rateMatch(input, ratings, 32)
    const four = result.teams[0]!.players
    const five = result.teams[1]!.players
    expect(new Set(four.map((player) => player.delta)).size).toBe(1)
    expect(new Set(five.map((player) => player.delta)).size).toBe(1)
    // The five-stack was the favourite (higher rating sum) and lost.
    expect(result.expected[0]).toBeLessThan(0.1)
    expect(four[0]!.delta).toBeGreaterThan(0)
    expect(five[0]!.delta).toBeLessThan(0)
  })

  test('a random gets an estimate from the known elos and the damage, and is never rated', () => {
    const { input, ratings } = match(
      [
        [
          { elo: 600, damage: 100, name: 'known' },
          { elo: 600, damage: 300, tracked: false, name: 'rand' },
        ],
        [
          { elo: 600, damage: 200, name: 'enemy1' },
          { elo: 600, damage: 200, name: 'enemy2' },
        ],
      ],
      0,
    )
    const { result, updates } = rateMatch(input, ratings, 32)
    const random = result.teams[0]!.players[1]!
    expect(random.tracked).toBe(false)
    expect(random.id).toBeNull()
    expect(random.elo).toBeGreaterThan(600)
    expect(random.eloAfter).toBe(random.elo)
    expect(random.delta).toBe(0)
    expect(updates.has('rand')).toBe(false)
    expect(updates.has('known')).toBe(true)
  })

  test('the random estimate follows relative damage without leaving the scale', () => {
    expect(estimateRandomElo(500, 100, 100)).toBe(500)
    const strong = estimateRandomElo(500, 200, 100)
    expect(strong).toBeGreaterThan(650)
    expect(strong).toBeLessThan(700)
    expect(estimateRandomElo(500, 50, 100)).toBeLessThan(400)
    expect(estimateRandomElo(950, 500, 1)).toBe(1000)
    expect(estimateRandomElo(150, 0, 100)).toBe(100)
  })

  test('a random filler counts at half weight in the expectation', () => {
    const withRandom = match([
      [
        { elo: 500, damage: 100, name: 'a' },
        { elo: 500, damage: 400, tracked: false, name: 'r' },
      ],
      [
        { elo: 500, damage: 250, name: 'b' },
        { elo: 500, damage: 250, name: 'c' },
      ],
    ])
    const allKnown = match([
      [
        { elo: 500, damage: 100, name: 'a' },
        { elo: 500, damage: 400, name: 'r' },
      ],
      [
        { elo: 500, damage: 250, name: 'b' },
        { elo: 500, damage: 250, name: 'c' },
      ],
    ])
    const randomResult = rateMatch(withRandom.input, withRandom.ratings, 32)
    const knownResult = rateMatch(allKnown.input, allKnown.ratings, 32)
    // A 400-damage random is only half a player in the rating sums, so that
    // team is the bigger underdog even though both line-ups dealt the same.
    expect(randomResult.result.expected[0]).toBeLessThan(knownResult.result.expected[0])
    expect(randomResult.updates.has('r')).toBe(false)
    expect(randomResult.updates.has('a')).toBe(true)
  })

  test('a 100-elo player cannot fall below the floor, nor a 1000 rise above it', () => {
    const { input, ratings } = match([
      [
        { elo: 1000, damage: 300 },
        { elo: 100, damage: 0 },
      ],
      [
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
      ],
    ])
    const { updates } = rateMatch(input, ratings, 64)
    expect(updates.get('p0')).toBe(1000)
    expect(updates.get('p1')).toBe(100)
  })

  test('a short-handed team is the underdog in the expectation', () => {
    const { input, ratings } = match([
      [
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
      ],
      [
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
        { elo: 500, damage: 100 },
      ],
    ])
    const { result } = rateMatch(input, ratings, 32)
    expect(result.expected[0]).toBeLessThan(result.expected[1]!)
  })
})

describe('replay', () => {
  const roster = [
    { id: 'a', name: 'Ada', baseElo: 700 },
    { id: 'b', name: 'Bo', baseElo: 700 },
  ]
  const oneVone = (
    id: string,
    position: number,
    winner: number,
    createdAt = position,
  ): RatingEvent => ({
    id,
    position,
    kind: 'match',
    createdAt,
    updatedAt: createdAt,
    payload: {
      label: id,
      winner,
      teams: [
        { players: [{ id: 'a', name: 'Ada', damage: 100, tracked: true }] },
        { players: [{ id: 'b', name: 'Bo', damage: 100, tracked: true }] },
      ],
    },
  })

  test('starts at the creation elo and applies every event in position order', () => {
    const events: RatingEvent[] = [
      oneVone('m1', 0, 0),
      {
        id: 'adjust',
        position: 1,
        kind: 'adjust',
        createdAt: 1,
        updatedAt: 1,
        payload: { playerId: 'a', elo: 1000, reason: 'test' },
      },
      oneVone('m2', 2, 1),
    ]
    const { elos, outcomes } = replay(events, roster, 32)
    expect(elos.get('a')).toBe(970)
    expect(elos.get('b')).toBe(714)
    expect(outcomes.get('m1')).toMatchObject({ kind: 'match' })
    expect(outcomes.get('adjust')).toMatchObject({
      kind: 'adjust',
      result: { playerId: 'a', eloBefore: 716, eloAfter: 1000 },
    })
  })

  test('is deterministic', () => {
    const events = [oneVone('m1', 0, 0), oneVone('m2', 1, 1)]
    const first = replay(events, roster, 32)
    const second = replay([...events].reverse(), roster, 32)
    expect([...first.elos]).toEqual([...second.elos])
  })

  test('deleting an event replays the tail from the new state', () => {
    const withAdjust: RatingEvent[] = [
      oneVone('m1', 0, 0),
      {
        id: 'adjust',
        position: 1,
        kind: 'adjust',
        createdAt: 1,
        updatedAt: 1,
        payload: { playerId: 'a', elo: 1000, reason: 'test' },
      },
      oneVone('m2', 2, 1),
    ]
    const without = replay(
      withAdjust.filter((event) => event.id !== 'adjust'),
      roster,
      32,
    )
    expect(without.elos.get('a')).toBe(698)
    expect(without.elos.get('b')).toBe(702)
  })

  test('reordering changes which match saw which rating', () => {
    const events: RatingEvent[] = [
      oneVone('m1', 0, 0),
      {
        id: 'adjust',
        position: 1,
        kind: 'adjust',
        createdAt: 1,
        updatedAt: 1,
        payload: { playerId: 'a', elo: 1000, reason: 'test' },
      },
      oneVone('m2', 2, 1),
    ]
    const reordered = replay(
      [
        events[0]!,
        { ...events[2]!, position: 1 },
        { ...events[1]!, position: 2 },
      ],
      roster,
      32,
    )
    expect(reordered.elos.get('a')).toBe(1000)
    expect(reordered.elos.get('b')).toBe(702)
  })

  test('K scales the whole history', () => {
    const events = [oneVone('m1', 0, 0)]
    const low = replay(events, roster, 8)
    const high = replay(events, roster, 64)
    expect(low.elos.get('a')).toBe(704)
    expect(high.elos.get('a')).toBe(732)
  })
})
