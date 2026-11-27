import { describe, expect, test } from 'bun:test'
import {
  buildRivalsMatchInput,
  matchRoster,
  normalizeUsername,
  usernameSimilarity,
  type RivalsDraft,
  type RivalsScan,
} from '../src/shared/rivals'
import {
  buildImportInput,
  choosePlayer,
  draftFromScan,
  draftStatuses,
  markRandom,
  setDamage,
  setUsername,
  swapTeams,
} from '../src/client/rivalsImport'
import type { Player } from '../src/shared/types'

const player = (id: string, name: string, username: string): Player => ({
  id,
  name,
  username,
  skill: 5,
  elo: 500,
  tags: [],
  sittingOut: false,
  createdAt: 0,
  updatedAt: 0,
})

const players: Player[] = [
  player('p1', 'Sniper King', 'sniperking'),
  player('p2', 'Zero Hero', 'ZeroHero'),
  player('p3', 'Purple Pal', 'purplepal'),
]

type ScanRow = RivalsScan['rows'][number]

const row = (overrides: Partial<ScanRow> & { index: number }): ScanRow => ({
  teamSlot: 0,
  color: 'gold',
  username: null,
  usernameConfidence: 0.95,
  damage: null,
  damageConfidence: 0.95,
  rawDamageText: null,
  issues: [],
  ...overrides,
})

const scan = (rows: ScanRow[], overrides: Partial<RivalsScan> = {}): RivalsScan => ({
  version: 1,
  image: { width: 1280, height: 720 },
  teams: [
    { slot: 0, color: 'gold', score: 5, confidence: 0.95 },
    { slot: 1, color: 'purple', score: 3, confidence: 0.95 },
  ],
  winnerSlot: 0,
  rows,
  issues: [],
  ...overrides,
})

const typicalScan = () =>
  scan([
    row({ index: 0, username: 'sniperking', damage: 12000, rawDamageText: '12,000' }),
    row({ index: 1, username: 'ZeroHero', damage: 0, rawDamageText: '0' }),
    row({
      index: 2,
      teamSlot: 1,
      color: 'purple',
      username: 'purplepal',
      damage: 4300,
      rawDamageText: '4,300',
    }),
  ])

describe('username normalisation and similarity', () => {
  test('handles are trimmed, whitespace-free and case-insensitive', () => {
    expect(normalizeUsername('  Sniper King ')).toBe('sniperking')
  })

  test('similarity is 1 for equal handles and drops with edits', () => {
    expect(usernameSimilarity('SniperKing', 'sniperking')).toBe(1)
    expect(usernameSimilarity('sniperk1ng', 'sniperking')).toBeGreaterThan(0.8)
    expect(usernameSimilarity('nightowl', 'sniperking')).toBeLessThan(0.5)
    expect(usernameSimilarity('', 'sniperking')).toBe(0)
  })
})

describe('roster matching', () => {
  test('an exact username match is automatic, whatever the case', () => {
    const [match] = matchRoster(['SNIPERKING'], players)
    expect(match?.status).toBe('matched')
    expect(match?.playerId).toBe('p1')
  })

  test('a look-alike spelling is settled by the roster', () => {
    // The on-device recogniser reads O as 0 and I/l as 1; the roster spelling wins.
    const [match] = matchRoster(['sniperk1ng'], players)
    expect(match?.status).toBe('matched')
    expect(match?.playerId).toBe('p1')
  })

  test('a fuzzy match is only a suggestion', () => {
    const [match] = matchRoster(['sniperkng'], players)
    expect(match?.status).toBe('suggested')
    expect(match?.playerId).toBeNull()
    expect(match?.candidates[0]?.id).toBe('p1')
  })

  test('an unknown username is unmatched', () => {
    const [match] = matchRoster(['nightowl'], players)
    expect(match?.status).toBe('unmatched')
    expect(match?.candidates).toEqual([])
  })

  test('duplicate roster usernames need a human choice', () => {
    const twins = [
      player('t1', 'One', 'shared'),
      player('t2', 'Two', 'Shared'),
    ]
    const [match] = matchRoster(['shared'], twins)
    expect(match?.status).toBe('review')
    expect(match?.candidates.map((entry) => entry.id).sort()).toEqual(['t1', 't2'])
  })

  test('the same player twice is never auto-matched twice', () => {
    const matches = matchRoster(['sniperking', 'SniperKing'], players)
    expect(matches.map((entry) => entry.status)).toEqual(['review', 'review'])
  })

  test('a player without a username is not matched by display name', () => {
    const roster = [player('x1', 'sniperking', '')]
    const [match] = matchRoster(['sniperking'], roster)
    expect(match?.status).toBe('unmatched')
  })
})

describe('review draft', () => {
  test('gold is team 0 and purple is team 1', () => {
    const draft = draftFromScan(typicalScan(), players)
    expect(draft.colors).toEqual(['gold', 'purple'])
    expect(draft.rows.map((entry) => entry.teamSlot)).toEqual([0, 0, 1])
    expect(draft.winner).toBe(0)
  })

  test('zero damage survives as "0" and missing damage stays blank', () => {
    const draft = draftFromScan(
      scan([
        row({ index: 0, username: 'sniperking', damage: 0 }),
        row({ index: 1, username: 'ZeroHero', damage: null }),
      ]),
      players,
    )
    expect(draft.rows[0]?.damage).toBe('0')
    expect(draft.rows[1]?.damage).toBe('')
  })

  test('an ambiguous row lands in team 0 with a warning', () => {
    const draft = draftFromScan(
      scan([row({ index: 0, teamSlot: null, color: null, username: 'sniperking', damage: 5 })]),
      players,
    )
    expect(draft.rows[0]?.teamSlot).toBe(0)
    expect(draft.rows[0]?.issues.join(' ')).toContain('Team colour unclear')
  })

  test('a tie leaves the winner unset', () => {
    const draft = draftFromScan(
      scan([row({ index: 0, username: 'sniperking', damage: 5 })], { winnerSlot: null }),
      players,
    )
    expect(draft.winner).toBeNull()
  })

  test('statuses distinguish matched, suggested, manual and random', () => {
    const draft = draftFromScan(
      scan([
        row({ index: 0, username: 'sniperking', damage: 10 }),
        row({ index: 1, username: 'sniperkng', damage: 20 }),
        row({ index: 2, teamSlot: 1, color: 'purple', username: 'nightowl', damage: 30 }),
      ]),
      players,
    )
    const statuses = draftStatuses(draft, players)
    expect(statuses[draft.rows[0]!.key]).toBe('matched')
    expect(statuses[draft.rows[1]!.key]).toBe('suggested')
    expect(statuses[draft.rows[2]!.key]).toBe('unmatched')

    const manual = choosePlayer(draft, draft.rows[1]!.key, 'p2')
    expect(draftStatuses(manual, players)[manual.rows[1]!.key]).toBe('manual')

    const random = markRandom(draft, draft.rows[2]!.key)
    expect(draftStatuses(random, players)[random.rows[2]!.key]).toBe('unmatched')
  })

  test('editing a username drops the automatic assignment', () => {
    const draft = draftFromScan(typicalScan(), players)
    const key = draft.rows[0]!.key
    const edited = setUsername(draft, key, 'zzzznotarealname')
    expect(edited.rows[0]?.choice).toBeNull()
    expect(draftStatuses(edited, players)[key]).toBe('unmatched')
  })

  test('editing a username keeps a hand-picked player', () => {
    const draft = draftFromScan(typicalScan(), players)
    const key = draft.rows[0]!.key
    const manual = choosePlayer(draft, key, 'p2')
    const edited = setUsername(manual, key, 'zzzz')
    expect(edited.rows[0]?.choice).toEqual({ kind: 'roster', playerId: 'p2', auto: false })
  })

  test('damage input keeps digits only', () => {
    const draft = draftFromScan(typicalScan(), players)
    const key = draft.rows[0]!.key
    expect(setDamage(draft, key, '12a3').rows[0]?.damage).toBe('123')
  })

  test('swapping teams moves rows, scores and the winner', () => {
    const draft = draftFromScan(typicalScan(), players)
    const swapped = swapTeams(draft)
    expect(swapped.colors).toEqual(['purple', 'gold'])
    expect(swapped.scores).toEqual([3, 5])
    expect(swapped.winner).toBe(1)
    expect(swapped.rows.map((entry) => entry.teamSlot)).toEqual([1, 1, 0])
  })
})

describe('MatchInput building', () => {
  test('a reviewed draft becomes the exact payload the route accepts', () => {
    const draft = draftFromScan(typicalScan(), players)
    const outcome = buildImportInput(draft, players)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { input } = outcome
    expect(Object.keys(input).sort()).toEqual(['label', 'teams', 'winner'])
    expect(input.label).toBe('RIVALS Screenshot Import')
    expect(input.winner).toBe(0)
    expect(input.teams[0]?.players).toEqual([
      { id: 'p1', name: 'Sniper King', damage: 12000, tracked: true },
      { id: 'p2', name: 'Zero Hero', damage: 0, tracked: true },
    ])
    expect(input.teams[1]?.players).toEqual([
      { id: 'p3', name: 'Purple Pal', damage: 4300, tracked: true },
    ])
    for (const team of input.teams)
      for (const entry of team.players)
        expect(Object.keys(entry).sort()).toEqual(['damage', 'id', 'name', 'tracked'])
  })

  test('an unmatched row can stay an untracked random with a client id', () => {
    const draft = draftFromScan(
      scan([
        row({ index: 0, username: 'sniperking', damage: 100 }),
        row({ index: 1, teamSlot: 1, color: 'purple', username: 'mystery', damage: 50 }),
      ]),
      players,
    )
    const outcome = buildImportInput(draft, players)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const random = outcome.input.teams[1]?.players[0]
    expect(random?.tracked).toBe(false)
    expect(random?.id).toBe(draft.rows[1]!.key)
    expect(random?.name).toBe('mystery')
  })

  test('marked randoms use their client key and unique ids', () => {
    const draft = draftFromScan(typicalScan(), players)
    const random = markRandom(draft, draft.rows[1]!.key)
    const outcome = buildImportInput(random, players)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const ids = outcome.input.teams.flatMap((team) => team.players.map((entry) => entry.id))
    expect(new Set(ids).size).toBe(ids.length)
    const entry = outcome.input.teams[0]!.players.find((item) => item.id === random.rows[1]!.key)
    expect(entry?.tracked).toBe(false)
  })

  test('duplicate roster ids are rejected', () => {
    const draft = draftFromScan(typicalScan(), players)
    const duplicated = choosePlayer(draft, draft.rows[2]!.key, 'p1')
    const outcome = buildImportInput(duplicated, players)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.errors.join(' ')).toContain('appears twice')
  })

  test('a tied or missing winner blocks submission', () => {
    const draft = draftFromScan(
      scan([row({ index: 0, username: 'sniperking', damage: 10 })], { winnerSlot: null }),
      players,
    )
    const outcome = buildImportInput(draft, players)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.errors).toContain('Choose the winning team.')
  })

  test('an invalid winner index is rejected', () => {
    const draft = draftFromScan(typicalScan(), players)
    const base = buildImportInput(draft, players)
    expect(base.ok).toBe(true)
    if (!base.ok) return
    const outcome = buildRivalsMatchInput({
      label: 'x',
      winner: 2,
      players: base.input.teams.flatMap((team, teamSlot) =>
        team.players.map((entry, index) => ({
          key: entry.id,
          username: entry.name,
          playerId: entry.tracked ? entry.id : null,
          playerName: entry.name,
          teamSlot,
          damage: String(entry.damage),
          tracked: entry.tracked,
        })),
      ),
    })
    expect(outcome.ok).toBe(false)
  })

  test('invalid and out-of-range damage is rejected', () => {
    const base: RivalsDraft = {
      label: 'Rivals',
      winner: 0,
      players: [
        {
          key: 'a',
          username: 'alpha',
          playerId: 'p1',
          playerName: 'Alpha',
          teamSlot: 0,
          damage: '10',
          tracked: true,
        },
        {
          key: 'b',
          username: 'beta',
          playerId: null,
          teamSlot: 1,
          damage: '5',
          tracked: false,
        },
      ],
    }
    for (const damage of ['', 'abc', '-5', '1.5', '100001']) {
      const outcome = buildRivalsMatchInput({
        ...base,
        players: base.players.map((entry, index) =>
          index === 0 ? { ...entry, damage } : entry,
        ),
      })
      expect(outcome.ok).toBe(false)
    }
  })

  test('zero damage is valid for one player but not for the whole match', () => {
    const base: RivalsDraft = {
      label: 'Rivals',
      winner: 0,
      players: [
        {
          key: 'a',
          username: 'alpha',
          playerId: 'p1',
          playerName: 'Alpha',
          teamSlot: 0,
          damage: '0',
          tracked: true,
        },
        {
          key: 'b',
          username: 'beta',
          playerId: 'p2',
          playerName: 'Beta',
          teamSlot: 1,
          damage: '50',
          tracked: true,
        },
      ],
    }
    const allowed = buildRivalsMatchInput(base)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.input.teams[0]?.players[0]?.damage).toBe(0)

    const none = buildRivalsMatchInput({
      ...base,
      players: base.players.map((entry) => ({ ...entry, damage: '0' })),
    })
    expect(none.ok).toBe(false)
  })

  test('at least one tracked roster player is required', () => {
    const outcome = buildRivalsMatchInput({
      label: '',
      winner: 0,
      players: [
        { key: 'a', username: 'alpha', playerId: null, teamSlot: 0, damage: '5', tracked: false },
        { key: 'b', username: 'beta', playerId: null, teamSlot: 1, damage: '6', tracked: false },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.errors).toContain('Match at least one player from your roster.')
  })

  test('a draft with no rows cannot be submitted', () => {
    const draft = draftFromScan(
      scan([row({ index: 0, username: 'sniperking', damage: 5 })]),
      players,
    )
    const outcome = buildImportInput({ ...draft, rows: [] }, players)
    expect(outcome.ok).toBe(false)
  })
})

