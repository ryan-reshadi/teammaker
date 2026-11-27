import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_K_FACTOR,
  ELO_MAX,
  ELO_MIN,
  FLAT_K_FORMULA,
  PLACEMENT_FORMULA,
  PROVISIONAL_MATCHES,
  clampElo,
  eloFromSkill,
  estimateRandomElo,
  eventFormula,
  expectationsFromStrengths,
  isKFactor,
  isPlacement,
  placementScores,
  provisionalK,
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

  test('damage is judged against the whole lobby, so a winning bottom fragger is not punished', () => {
    // Team 0 are the favourites. Their bottom fragger out-damaged the whole
    // other team but was the weakest on their own, and their rating alone said
    // they should have dealt more — enough to turn the win into a loss.
    const winners = [900, 700, 500, 300, 200]
    const losers = [150, 120, 100, 80, 60]
    const { input, ratings } = match([
      winners.map((damage) => ({ elo: 600, damage })),
      losers.map((damage) => ({ elo: 500, damage })),
    ])
    const { result } = rateMatch(input, ratings, 32)
    const bottom = result.teams[0]!.players[4]!
    const top = result.teams[0]!.players[0]!
    expect(bottom.delta).toBeGreaterThan(0)
    expect(top.delta).toBeGreaterThan(bottom.delta)
    for (const player of result.teams[0]!.players)
      expect(player.delta).toBeGreaterThanOrEqual(0)

    // Doing less than most of the lobby on the same winning team still pays.
    const behind = match([
      [900, 700, 500, 300, 50].map((damage) => ({ elo: 600, damage })),
      losers.map((damage) => ({ elo: 500, damage })),
    ])
    const quiet = rateMatch(behind.input, behind.ratings, 32).result.teams[0]!.players[4]!
    expect(quiet.delta).toBeLessThan(0)
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

describe('multi-team matches', () => {
  test('a three-team match shares one win between the field and stays zero-sum', () => {
    const { input, ratings } = match([
      [{ elo: 500, damage: 100, name: 'a' }],
      [{ elo: 500, damage: 100, name: 'b' }],
      [{ elo: 500, damage: 100, name: 'c' }],
    ])
    const { result, updates } = rateMatch(input, ratings, 32)
    expect(result.expected).toHaveLength(3)
    for (const value of result.expected) expect(value).toBeCloseTo(1 / 3, 5)
    expect(updates.get('a')).toBe(521)
    expect(updates.get('b')).toBe(489)
    expect(updates.get('c')).toBe(489)
    // A win is worth more against a bigger field, and the losses pay for it.
    const total = [...updates.values()].reduce((sum, elo) => sum + elo, 0)
    expect(Math.abs(total - 1500)).toBeLessThanOrEqual(1)
  })

  test('damage is normalized by the players on the other teams', () => {
    // The solo player faces four enemies, so 200 damage is 50 a head; the pairs
    // face three enemies each, so their 150 is also 50 a head. Everyone has the
    // same performance share and only the result and the rating sums move them.
    const { input, ratings } = match(
      [
        [{ elo: 500, damage: 200, name: 'a' }],
        [
          { elo: 500, damage: 150, name: 'b' },
          { elo: 500, damage: 150, name: 'c' },
        ],
        [
          { elo: 500, damage: 150, name: 'd' },
          { elo: 500, damage: 150, name: 'e' },
        ],
      ],
      0,
    )
    const { result } = rateMatch(input, ratings, 32)
    // One player against two pairs is a heavy underdog, so the win pays well.
    expect(result.expected[0]).toBeCloseTo(0.0355, 3)
    for (const team of result.teams)
      expect(new Set(team.players.map((player) => player.delta)).size).toBe(1)
    expect(result.teams[0]!.players[0]!.delta).toBe(31)
    expect(result.teams[1]!.players[0]!.delta).toBe(-15)

    // The same solo player's share is set by damage per enemy, not raw damage:
    // 50 over four enemies is a quarter of the rate and earns a smaller swing.
    const raw = rateMatch(
      { ...input, teams: [{ players: [{ ...input.teams[0]!.players[0]!, damage: 50 }] }, ...input.teams.slice(1)] },
      ratings,
      32,
    )
    expect(raw.result.teams[0]!.players[0]!.delta).toBeLessThan(
      result.teams[0]!.players[0]!.delta,
    )
  })

  test('rejects fewer than two or more than eight teams and a winner out of range', () => {
    const solo = match([[{ elo: 500, damage: 100 }]])
    expect(rateMatch(solo.input, solo.ratings, 32).result.teams).toHaveLength(0)
    const crowd = match(Array.from({ length: 9 }, () => [{ elo: 500, damage: 100 }]))
    expect(rateMatch(crowd.input, crowd.ratings, 32).result.teams).toHaveLength(0)
    const three = match([
      [{ elo: 500, damage: 100 }],
      [{ elo: 500, damage: 100 }],
      [{ elo: 500, damage: 100 }],
    ])
    expect(
      rateMatch({ ...three.input, winner: 3 }, three.ratings, 32).result.teams,
    ).toHaveLength(0)
  })

  test('eight teams each get an expectation and a rating change', () => {
    const { input, ratings } = match(
      Array.from({ length: 8 }, (_entry, index) => [
        { elo: 500, damage: 100, name: `t${index}` },
      ]),
      5,
    )
    const { result, updates } = rateMatch(input, ratings, 32)
    expect(result.teams).toHaveLength(8)
    for (const value of result.expected) expect(value).toBeCloseTo(1 / 8, 5)
    expect(updates.get('t5')).toBeGreaterThan(500)
    for (let index = 0; index < 8; index++)
      if (index !== 5) expect(updates.get(`t${index}`)).toBeLessThan(500)
  })
})

describe('placement matches', () => {
  /** Five prior matches per id, so provisional K does not inflate the numbers. */
  const settled = (ids: string[]) => new Map(ids.map((id) => [id, 5]))

  test('every pair hands out one point, so the shares sum to one', () => {
    const even = placementScores([1, 2, 3])
    expect(even.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12)
    expect(even[0]).toBeCloseTo(2 / 3, 12)
    expect(even[1]).toBeCloseTo(1 / 3, 12)
    expect(even[2]).toBe(0)
    // A tied pair splits its point, so sharing second is worth less than
    // holding it: 1/6 each instead of 1/3.
    const tied = placementScores([1, 2, 2])
    expect(tied[1]).toBeCloseTo(1 / 6, 12)
    expect(tied[1]).toBeCloseTo(tied[2]!, 12)
    expect(tied.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12)
    // The shares follow the places, not the slots they arrive in.
    expect(placementScores([3, 1, 2])[1]).toBeCloseTo(2 / 3, 12)
    expect(placementScores([3, 1, 2])[2]).toBeCloseTo(1 / 3, 12)
    expect(placementScores([3, 1, 2])[0]).toBe(0)
    // Two teams are a plain win or loss, and a tied pair is half each.
    expect(placementScores([1, 2])).toEqual([1, 0])
    expect(placementScores([1, 1])).toEqual([0.5, 0.5])
  })

  test('only an explicit v3 marker reads the places', () => {
    expect(eventFormula({ label: '', winner: 0, teams: [] })).toBe(1)
    expect(eventFormula({ label: '', winner: 0, teams: [], formula: 2 })).toBe(2)
    expect(
      eventFormula({ label: '', winner: 0, teams: [], formula: PLACEMENT_FORMULA }),
    ).toBe(3)
    expect(isPlacement([1, 2], 2)).toBe(true)
    expect(isPlacement([2, 1], 2)).toBe(true)
    expect(isPlacement([1, 1], 2)).toBe(true)
    expect(isPlacement([1, 2, 3], 2)).toBe(false)
    expect(isPlacement([0, 1], 2)).toBe(false)
    expect(isPlacement([1, 1.5], 2)).toBe(false)
    expect(isPlacement([1, 3], 2)).toBe(false)
    expect(isPlacement(undefined, 2)).toBe(false)
  })

  test('two teams with a placing rate exactly like the winner flag', () => {
    const { input, ratings } = match([
      [{ elo: 500, damage: 100, name: 'a' }],
      [{ elo: 500, damage: 100, name: 'b' }],
    ])
    const priorMatches = settled(['a', 'b'])
    const winner = rateMatch(input, ratings, 32, { formula: 2, priorMatches })
    const placed = rateMatch(
      { ...input, formula: PLACEMENT_FORMULA, places: [1, 2] },
      ratings,
      32,
      { formula: PLACEMENT_FORMULA, priorMatches },
    )
    expect([...placed.updates]).toEqual([...winner.updates])
    expect(placed.result.teams[0]!.players[0]!.delta).toBe(16)
    expect(placed.result.teams[1]!.players[0]!.delta).toBe(-16)
  })

  test('a place is the share of the field it finished above', () => {
    const { input, ratings } = match([
      [{ elo: 500, damage: 100, name: 'a' }],
      [{ elo: 500, damage: 100, name: 'b' }],
      [{ elo: 500, damage: 100, name: 'c' }],
    ])
    const priorMatches = settled(['a', 'b', 'c'])
    const placed = rateMatch(
      { ...input, formula: PLACEMENT_FORMULA, places: [1, 2, 3] },
      ratings,
      32,
      { formula: PLACEMENT_FORMULA, priorMatches },
    )
    // Second of three is one win and one loss against equals, which is par.
    expect(placed.result.teams[0]!.players[0]!.delta).toBe(11)
    expect(placed.result.teams[1]!.players[0]!.delta).toBe(0)
    expect(placed.result.teams[2]!.players[0]!.delta).toBe(-11)
    // The expectations are the same win shares as before; only the outcome moved.
    for (const share of placed.result.expected) expect(share).toBeCloseTo(1 / 3, 6)

    const tied = rateMatch(
      { ...input, formula: PLACEMENT_FORMULA, places: [1, 2, 2] },
      ratings,
      32,
      { formula: PLACEMENT_FORMULA, priorMatches },
    )
    expect(tied.result.teams[0]!.players[0]!.delta).toBe(11)
    expect(tied.result.teams[1]!.players[0]!.delta).toBe(-5)
    expect(tied.result.teams[2]!.players[0]!.delta).toBe(-5)
  })

  test('eight teams spread the same K across the whole order', () => {
    const ids = Array.from({ length: 8 }, (_entry, index) => `t${index}`)
    const { input, ratings } = match(
      ids.map((id) => [{ elo: 500, damage: 100, name: id }]),
    )
    const { result } = rateMatch(
      { ...input, formula: PLACEMENT_FORMULA, places: [1, 2, 3, 4, 5, 6, 7, 8] },
      ratings,
      32,
      { formula: PLACEMENT_FORMULA, priorMatches: settled(ids) },
    )
    const deltas = result.teams.map((team) => team.players[0]!.delta)
    expect(deltas).toEqual([4, 3, 2, 1, -1, -2, -3, -4])
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
  })

  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
    id,
    name: id.toUpperCase(),
    baseElo: 500,
  }))
  const fieldEvent = (payload: {
    formula?: 2 | 3
    places?: number[]
    winner?: number
  }): RatingEvent => ({
    id: 'field',
    position: 0,
    kind: 'match',
    createdAt: 0,
    updatedAt: 0,
    payload: {
      label: 'field',
      winner: payload.winner ?? 0,
      teams: [
        {
          players: [
            { id: 'a', name: 'Ada', damage: 100, tracked: true },
            { id: 'b', name: 'Bo', damage: 100, tracked: true },
          ],
        },
        {
          players: [
            { id: 'c', name: 'Cy', damage: 100, tracked: true },
            { id: 'd', name: 'Di', damage: 100, tracked: true },
          ],
        },
        {
          players: [
            { id: 'e', name: 'Eve', damage: 100, tracked: true },
            { id: 'f', name: 'Finn', damage: 100, tracked: true },
          ],
        },
      ],
      ...(payload.formula === undefined ? {} : { formula: payload.formula }),
      ...(payload.places === undefined ? {} : { places: payload.places }),
    },
  })

  test('places on an unmarked event leave every stored rating alone', () => {
    const plain = replay([fieldEvent({})], six, 32)
    const withPlaces = replay([fieldEvent({ places: [1, 2, 3] })], six, 32)
    expect([...withPlaces.elos]).toEqual([...plain.elos])
    expect(withPlaces.outcomes.get('field')).toEqual(plain.outcomes.get('field'))
    // The pinned legacy numbers: v1 keeps the passed K and the winner flag.
    expect([...plain.elos]).toEqual([
      ['a', 521],
      ['b', 521],
      ['c', 489],
      ['d', 489],
      ['e', 489],
      ['f', 489],
    ])
  })

  test('a v3 event rates the stored order, not the winner flag', () => {
    const { elos } = replay(
      [fieldEvent({ formula: PLACEMENT_FORMULA, places: [2, 1, 3], winner: 0 })],
      six,
      32,
    )
    // The first five matches still use double K, so a third of the field is 21.
    expect([...elos]).toEqual([
      ['a', 500],
      ['b', 500],
      ['c', 521],
      ['d', 521],
      ['e', 479],
      ['f', 479],
    ])
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

describe('win expectations', () => {
  test('the 400-point divisor pins the calibration anchors', () => {
    const favourite = (gap: number) =>
      expectationsFromStrengths([500, 500 + gap])[1]!
    expect(expectationsFromStrengths([500, 500])[0]).toBeCloseTo(0.5, 6)
    expect(favourite(100)).toBeCloseTo(0.6401, 3)
    expect(favourite(200)).toBeCloseTo(0.7597, 3)
    expect(favourite(300)).toBeCloseTo(0.8490, 3)
    expect(favourite(400)).toBeCloseTo(0.9091, 3)
    expect(favourite(500)).toBeCloseTo(0.9468, 3)
    expect(expectationsFromStrengths([600, 500])[0]).toBeCloseTo(
      1 - expectationsFromStrengths([500, 600])[0]!,
      6,
    )
  })

  test('multi-team shares still sum to one', () => {
    const even = expectationsFromStrengths([1500, 1500, 1500])
    for (const share of even) expect(share).toBeCloseTo(1 / 3, 6)
    const field = expectationsFromStrengths([1800, 1500, 1200])
    expect(field.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 8)
    expect(field[0]!).toBeGreaterThan(field[1]!)
    expect(field[1]!).toBeGreaterThan(field[2]!)
  })
})

describe('provisional K and formula versions', () => {
  const roster = [
    { id: 'a', name: 'Ada', baseElo: 700 },
    { id: 'b', name: 'Bo', baseElo: 700 },
  ]
  const oneVone = (
    id: string,
    position: number,
    winner: number,
  ): RatingEvent => ({
    id,
    position,
    kind: 'match',
    createdAt: position,
    updatedAt: position,
    payload: {
      label: id,
      winner,
      teams: [
        { players: [{ id: 'a', name: 'Ada', damage: 100, tracked: true }] },
        { players: [{ id: 'b', name: 'Bo', damage: 100, tracked: true }] },
      ],
    },
  })

  test('double K for the first five matches, capped at the maximum', () => {
    expect(PROVISIONAL_MATCHES).toBe(5)
    expect(provisionalK(32, 0)).toBe(64)
    expect(provisionalK(32, 4)).toBe(64)
    expect(provisionalK(32, 5)).toBe(32)
    expect(provisionalK(8, 0)).toBe(16)
    expect(provisionalK(64, 0)).toBe(64)
  })

  test('v4 keeps the account K for every match, however new the player', () => {
    const { input, ratings } = match([
      [{ elo: 500, damage: 100 }],
      [{ elo: 500, damage: 100 }],
    ])
    expect(FLAT_K_FORMULA).toBe(4)
    expect(eventFormula({ label: '', winner: 0, teams: [], formula: 4 })).toBe(4)
    const first = rateMatch(input, ratings, 32, {
      formula: FLAT_K_FORMULA,
      priorMatches: new Map([['p0', 0], ['p1', 0]]),
    })
    expect(first.result.teams[0]!.players[0]!.delta).toBe(16)
    expect(first.result.teams[1]!.players[0]!.delta).toBe(-16)
    // A v2 event stored before this change keeps the doubled K it was rated
    // with, so switching new matches to flat K moves no existing rating.
    const stamped = (formula: 2 | 4): RatingEvent => ({
      id: 'duel',
      position: 0,
      kind: 'match',
      createdAt: 0,
      updatedAt: 0,
      payload: {
        label: 'duel',
        winner: 0,
        formula,
        k: 32,
        teams: [
          { players: [{ id: 'a', name: 'Ada', damage: 100, tracked: true }] },
          { players: [{ id: 'b', name: 'Bo', damage: 100, tracked: true }] },
        ],
      },
    })
    expect(replay([stamped(2)], roster, 32).elos.get('a')).toBe(732)
    expect(replay([stamped(4)], roster, 32).elos.get('a')).toBe(716)
  })

  test('v2 applies the per-player K, while v1 keeps the passed K', () => {
    const { input, ratings } = match([
      [{ elo: 500, damage: 100 }],
      [{ elo: 500, damage: 100 }],
    ])
    const provisional = rateMatch(input, ratings, 32, { formula: 2 })
    expect(provisional.result.teams[0]!.players[0]!.delta).toBe(32)
    const settled = rateMatch(input, ratings, 32, {
      formula: 2,
      priorMatches: new Map([['p0', 5], ['p1', 5]]),
    })
    expect(settled.result.teams[0]!.players[0]!.delta).toBe(16)
    const legacy = rateMatch(input, ratings, 32)
    expect(legacy.result.teams[0]!.players[0]!.delta).toBe(16)
  })

  test('adjustments do not count as provisional matches', () => {
    const adjust: RatingEvent = {
      id: 'adjust',
      position: 0,
      kind: 'adjust',
      createdAt: 0,
      updatedAt: 0,
      payload: { playerId: 'a', elo: 700, reason: 'test' },
    }
    const duel: RatingEvent = {
      id: 'duel',
      position: 1,
      kind: 'match',
      createdAt: 1,
      updatedAt: 1,
      payload: {
        label: '',
        winner: 0,
        formula: 2,
        k: 32,
        teams: [
          { players: [{ id: 'a', name: 'Ada', damage: 100, tracked: true }] },
          { players: [{ id: 'b', name: 'Bo', damage: 100, tracked: true }] },
        ],
      },
    }
    const result = replay([adjust, duel], roster, 32, 32)
    const outcome = result.outcomes.get('duel')
    expect(outcome?.kind).toBe('match')
    if (outcome?.kind === 'match')
      expect(outcome.result.teams[0]!.players[0]!.delta).toBe(32)
  })

  test('the legacy replay fixture pins the pre-versioning deltas', () => {
    const four = [
      { id: 'a', name: 'Ada', baseElo: 500 },
      { id: 'b', name: 'Bo', baseElo: 500 },
      { id: 'c', name: 'Cy', baseElo: 500 },
      { id: 'd', name: 'Di', baseElo: 500 },
    ]
    const twoTeam: RatingEvent = {
      id: 'two-team',
      position: 0,
      kind: 'match',
      createdAt: 0,
      updatedAt: 0,
      payload: {
        label: 'Two-team fixture',
        winner: 0,
        teams: [
          {
            players: [
              { id: 'a', name: 'Ada', damage: 100, tracked: true },
              { id: 'b', name: 'Bo', damage: 100, tracked: true },
            ],
          },
          {
            players: [
              { id: 'c', name: 'Cy', damage: 100, tracked: true },
              { id: 'd', name: 'Di', damage: 100, tracked: true },
            ],
          },
        ],
      },
    }
    const duel = replay([twoTeam], four, 32)
    expect([...duel.elos]).toEqual([
      ['a', 516],
      ['b', 516],
      ['c', 484],
      ['d', 484],
    ])

    const six = [
      { id: 'a', name: 'Ada', baseElo: 500 },
      { id: 'b', name: 'Bo', baseElo: 500 },
      { id: 'c', name: 'Cy', baseElo: 500 },
      { id: 'd', name: 'Di', baseElo: 500 },
      { id: 'e', name: 'Eve', baseElo: 500 },
      { id: 'f', name: 'Finn', baseElo: 500 },
    ]
    const threeTeam: RatingEvent = {
      id: 'three-team',
      position: 0,
      kind: 'match',
      createdAt: 0,
      updatedAt: 0,
      payload: {
        label: 'Three-team fixture',
        winner: 0,
        teams: [
          {
            players: [
              { id: 'a', name: 'Ada', damage: 100, tracked: true },
              { id: 'b', name: 'Bo', damage: 100, tracked: true },
            ],
          },
          {
            players: [
              { id: 'c', name: 'Cy', damage: 100, tracked: true },
              { id: 'd', name: 'Di', damage: 100, tracked: true },
            ],
          },
          {
            players: [
              { id: 'e', name: 'Eve', damage: 100, tracked: true },
              { id: 'f', name: 'Finn', damage: 100, tracked: true },
            ],
          },
        ],
      },
    }
    const field = replay([threeTeam], six, 32)
    expect([...field.elos]).toEqual([
      ['a', 521],
      ['b', 521],
      ['c', 489],
      ['d', 489],
      ['e', 489],
      ['f', 489],
    ])
  })

  test('a legacy event is identical whatever the current K is', () => {
    const legacy = oneVone('legacy', 0, 0)
    const old = replay([legacy], roster, 8, 32)
    const changed = replay([legacy], roster, 64, 32)
    expect([...changed.elos]).toEqual([...old.elos])
    expect(changed.outcomes.get('legacy')).toEqual(old.outcomes.get('legacy'))
  })

  test('appending a v2 match leaves the earlier v1 outcome untouched', () => {
    const legacy = oneVone('legacy', 0, 0)
    const next: RatingEvent = {
      id: 'next',
      position: 1,
      kind: 'match',
      createdAt: 1,
      updatedAt: 1,
      payload: {
        label: 'next',
        winner: 1,
        formula: 2,
        k: 32,
        teams: [
          { players: [{ id: 'a', name: 'Ada', damage: 100, tracked: true }] },
          { players: [{ id: 'b', name: 'Bo', damage: 100, tracked: true }] },
        ],
      },
    }
    const old = replay([legacy], roster, 8, 32)
    const combined = replay([legacy, next], roster, 8, 32)
    expect(combined.outcomes.get('legacy')).toEqual(old.outcomes.get('legacy'))
    // The v2 event starts from the legacy result, not from the creation elo.
    const outcome = combined.outcomes.get('next')
    expect(outcome?.kind).toBe('match')
    if (outcome?.kind === 'match')
      expect(outcome.result.teams[0]!.players[0]!.eloBefore).toBe(
        old.elos.get('a')!,
      )
  })

  test('a v2 event uses its own K after the provisional window', () => {
    const { input, ratings } = match([
      [{ elo: 700, damage: 100 }],
      [{ elo: 700, damage: 100 }],
    ])
    const result = rateMatch(input, ratings, 8, {
      formula: 2,
      priorMatches: new Map([['p0', 5], ['p1', 5]]),
    })
    expect(result.result.teams[0]!.players[0]!.delta).toBe(4)
  })
})
