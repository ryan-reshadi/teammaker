import { expect, test } from 'bun:test'
import { rematchDraft } from '../src/client/rematch'
import type { MatchEventView } from '../src/shared/elo'
import type { Player } from '../src/shared/types'

const player = (id: string, name: string): Player => ({
  id,
  name,
  skill: 5,
  elo: 500,
  tags: [],
  sittingOut: false,
  createdAt: 1,
  updatedAt: 1,
})

const event: MatchEventView = {
  id: 'm1',
  kind: 'match',
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  label: 'Tuesday scrim',
  winner: 1,
  teams: [
    {
      players: [
        {
          id: 'a',
          name: 'Ada',
          damage: 120,
          tracked: true,
          elo: 500,
          eloBefore: 500,
          eloAfter: 516,
          delta: 16,
        },
        {
          id: null,
          name: 'Random 1',
          damage: 80,
          tracked: false,
          elo: 480,
          eloBefore: 480,
          eloAfter: 480,
          delta: 0,
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
          eloAfter: 484,
          delta: -16,
        },
      ],
    },
  ],
}

test('a rematch keeps the line-ups, blanks damage and resets the winner', () => {
  const result = rematchDraft(event, [player('a', 'Ada'), player('b', 'Bo')])
  expect('draft' in result).toBe(true)
  if (!('draft' in result)) return
  expect(result.draft.label).toBe('Tuesday scrim (rematch)')
  expect(result.draft.winner).toBe(0)
  expect(result.draft.teams).toHaveLength(2)
  const [ada, random] = result.draft.teams[0]!
  expect(ada).toMatchObject({ id: 'a', name: 'Ada', tracked: true, damage: '' })
  expect(random).toMatchObject({ name: 'Random 1', tracked: false, damage: '' })
  expect(random!.id).toBe(random!.key)
  expect(random!.id).not.toBe('')
  expect(result.draft.teams[1]![0]).toMatchObject({ id: 'b', tracked: true, damage: '' })
  // The original log entry is not mutated.
  expect(event.teams[0]!.players[0]!.damage).toBe(120)
})

test('a rematch is refused when a tracked player has left the roster', () => {
  const result = rematchDraft(event, [player('b', 'Bo')])
  expect('error' in result).toBe(true)
  if ('error' in result) expect(result.error).toContain('Ada')
})

test('a rematch label stays within the label limit', () => {
  const long = { ...event, label: 'x'.repeat(60) }
  const result = rematchDraft(long, [player('a', 'Ada'), player('b', 'Bo')])
  if (!('draft' in result)) throw new Error('expected a draft')
  expect(result.draft.label.length).toBe(60)
})