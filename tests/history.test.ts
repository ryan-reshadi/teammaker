import { expect, test } from 'bun:test'
import type { RatingEventView } from '../src/shared/elo'
import { playerHistory, sparklinePoints } from '../src/shared/history'

const events: RatingEventView[] = [
  {
    id: 'm1',
    kind: 'match',
    position: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    label: 'First',
    winner: 0,
    teams: [
      {
        players: [
          {
            id: 'a',
            name: 'Ada',
            damage: 100,
            tracked: true,
            elo: 500,
            eloBefore: 500,
            eloAfter: 532,
            delta: 32,
          },
        ],
      },
      {
        players: [
          {
            id: 'b',
            name: 'Bo',
            damage: 100,
            tracked: true,
            elo: 500,
            eloBefore: 500,
            eloAfter: 468,
            delta: -32,
          },
        ],
      },
    ],
  },
  {
    id: 'adj',
    kind: 'adjust',
    position: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    playerId: 'a',
    name: 'Ada',
    reason: 'VOD review',
    eloBefore: 532,
    eloAfter: 600,
    delta: 68,
  },
  {
    id: 'm2',
    kind: 'match',
    position: 2,
    createdAt: 3_000,
    updatedAt: 3_000,
    label: '',
    winner: 1,
    teams: [
      {
        players: [
          {
            id: 'a',
            name: 'Ada',
            damage: 100,
            tracked: true,
            elo: 600,
            eloBefore: 600,
            eloAfter: 584,
            delta: -16,
          },
        ],
      },
      {
        players: [
          {
            id: 'b',
            name: 'Bo',
            damage: 100,
            tracked: true,
            elo: 468,
            eloBefore: 468,
            eloAfter: 484,
            delta: 16,
          },
        ],
      },
    ],
  },
]

test('a player history is the ordered slice of matches and adjustments', () => {
  const history = playerHistory(events, 'a')
  expect(history.map((entry) => entry.kind)).toEqual(['match', 'adjust', 'match'])
  expect(history[0]).toMatchObject({
    label: 'First',
    won: true,
    delta: 32,
    eloBefore: 500,
    eloAfter: 532,
  })
  expect(history[1]).toMatchObject({
    label: 'VOD review',
    delta: 68,
    eloBefore: 532,
    eloAfter: 600,
  })
  expect(history[2]).toMatchObject({ label: 'Match', won: false, delta: -16 })
  expect(playerHistory(events, 'b').map((entry) => entry.id)).toEqual(['m1', 'm2'])
  expect(playerHistory(events, 'missing')).toEqual([])
})

test('sparkline points span the width and centre a flat line', () => {
  const points = sparklinePoints([500, 532, 600], 180, 40).split(' ')
  expect(points).toHaveLength(3)
  expect(points[0]).toBe('0.0,40.0')
  expect(points[2]).toBe('180.0,0.0')
  expect(sparklinePoints([500, 500], 180, 40)).toBe('0.0,20.0 180.0,20.0')
  expect(sparklinePoints([], 180, 40)).toBe('')
})