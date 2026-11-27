import { expect, test } from 'bun:test'
import { matchSitOutCounts, savedRoundSitOutCounts, sitOutCounts } from '../src/shared/bench'
import type { RatingEventView } from '../src/shared/elo'
import type { Player, Round } from '../src/shared/types'

const player = (id: string, createdAt: number): Player => ({
  id,
  name: id.toUpperCase(),
  skill: 5,
  elo: 500,
  tags: [],
  sittingOut: false,
  createdAt,
  updatedAt: createdAt,
})

const players = [player('a', 1_000), player('b', 2_000), player('c', 3_000)]

const match = (
  id: string,
  position: number,
  createdAt: number,
  ids: string[],
): RatingEventView => ({
  id,
  kind: 'match',
  position,
  createdAt,
  updatedAt: createdAt,
  label: id,
  winner: 0,
  teams: [
    {
      players: ids.map((playerId) => ({
        id: playerId,
        name: playerId.toUpperCase(),
        damage: 100,
        tracked: true,
        elo: 500,
        eloBefore: 500,
        eloAfter: 500,
        delta: 0,
      })),
    },
    {
      players: [
        {
          id: 'opponent',
          name: 'Opponent',
          damage: 100,
          tracked: false,
          elo: 500,
          eloBefore: 500,
          eloAfter: 500,
          delta: 0,
        },
      ],
    },
  ],
})

const adjustment: RatingEventView = {
  id: 'adjust',
  kind: 'adjust',
  position: 1,
  createdAt: 2_500,
  updatedAt: 2_500,
  playerId: 'a',
  name: 'A',
  reason: 'manual',
  eloBefore: 500,
  eloAfter: 600,
  delta: 100,
}

test('match sit-out counts only include players who already existed', () => {
  const counts = matchSitOutCounts(
    [match('m1', 0, 2_500, ['a']), adjustment, match('m2', 2, 4_000, ['a', 'b'])],
    players,
  )
  // At m1, b existed and sat; c did not exist yet. At m2, c sat.
  expect(counts).toEqual({ b: 1, c: 1 })
})

test('saved rounds are the fallback only when no matches exist', () => {
  const rounds: Round[] = [
    {
      id: 'r1',
      createdAt: 1,
      config: {
        version: 2,
        teamCount: 2,
        tolerance: 0,
        spread: 0,
        teams: [],
        benchedIds: ['a', 'b'],
      },
    },
    {
      id: 'r2',
      createdAt: 2,
      config: {
        version: 2,
        teamCount: 2,
        tolerance: 0,
        spread: 0,
        teams: [],
        benchedIds: ['a'],
      },
    },
  ]
  expect(savedRoundSitOutCounts(rounds)).toEqual({ a: 2, b: 1 })
  expect(sitOutCounts([], rounds, players)).toEqual({
    counts: { a: 2, b: 1 },
    source: 'rounds',
    matchCount: 0,
  })
  expect(sitOutCounts([match('m1', 0, 2_500, ['a'])], rounds, players)).toEqual({
    counts: { b: 1 },
    source: 'matches',
    matchCount: 1,
  })
  expect(sitOutCounts([], [], players)).toEqual({
    counts: {},
    source: 'none',
    matchCount: 0,
  })
})