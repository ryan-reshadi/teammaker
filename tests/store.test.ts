import { beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from '../src/client/store'
import {
  importLegacyRounds,
  readLocalRounds,
  readSitOuts,
  saveLocalRound,
  wereLegacyRoundsImported,
  writeSitOuts,
} from '../src/client/localState'
import { DEFAULT_K_FACTOR } from '../src/shared/elo'

/**
 * The local store is what every signed-out visitor gets, so it has to behave
 * like a complete store rather than a remote one with holes.
 */

const memory = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
    removeItem: (key: string) => {
      memory.delete(key)
    },
    clear: () => {
      memory.clear()
    },
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size
    },
  },
})

beforeEach(() => {
  memory.clear()
})

async function seeded() {
  const store = createStore(false)
  const [player] = await store.addPlayers([{ name: 'Ada', skill: 5 }])
  return { store, player: player! }
}

describe('the device-only store', () => {
  test('answers the match log with an empty log instead of an error', async () => {
    const store = createStore(false)
    expect(await store.matches()).toEqual({
      kFactor: DEFAULT_K_FACTOR,
      events: [],
      squashed: null,
    })
  })

  test('a skill patch sets the elo band, and a reload keeps it', async () => {
    const { store, player } = await seeded()
    expect(player.elo).toBe(500)
    const next = await store.updatePlayer(player.id, { skill: 9 })
    expect(next.skill).toBe(9)
    expect(next.elo).toBe(900)
    const [reloaded] = await createStore(false).players()
    expect(reloaded?.skill).toBe(9)
    expect(reloaded?.elo).toBe(900)
  })

  test('an elo patch snaps the skill mirror to the band', async () => {
    const { store, player } = await seeded()
    const next = await store.updatePlayer(player.id, { elo: 600 })
    expect(next.elo).toBe(600)
    expect(next.skill).toBe(6)
  })

  test('an elo patch wins when a patch carries both', async () => {
    const { store, player } = await seeded()
    const next = await store.updatePlayer(player.id, { skill: 9, elo: 600 })
    expect(next.elo).toBe(600)
    expect(next.skill).toBe(6)
  })

  test('a name patch leaves the rating alone', async () => {
    const { store, player } = await seeded()
    await store.updatePlayer(player.id, { elo: 512 })
    const renamed = await store.updatePlayer(player.id, { name: 'Ada Lovelace' })
    expect(renamed.elo).toBe(512)
    expect(renamed.skill).toBe(5)
  })

  test('sit-outs are device-local and scoped to their group', () => {
    writeSitOuts('local', ['a', 'b'])
    writeSitOuts('other', ['c'])
    expect(readSitOuts('local')).toEqual(['a', 'b'])
    expect(readSitOuts('other')).toEqual(['c'])
    expect(readSitOuts('missing')).toEqual([])

    // Writing again replaces the set rather than appending forever.
    writeSitOuts('local', ['a', 'a'])
    expect(readSitOuts('local')).toEqual(['a'])
  })

  test('saved rounds are local, newest first, and capped per group', () => {
    const config = {
      version: 2 as const,
      teamCount: 2,
      tolerance: 100,
      spread: 0,
      teams: [],
      benchedIds: [],
    }
    saveLocalRound('local', { id: 'one', createdAt: 1, config })
    const next = saveLocalRound('local', { id: 'two', createdAt: 2, config })
    expect(next.map((round) => round.id)).toEqual(['two', 'one'])
    expect(readLocalRounds('other')).toEqual([])
  })

  test('legacy server rounds are imported once and merged newest first', () => {
    const config = {
      version: 2 as const,
      teamCount: 2,
      tolerance: 100,
      spread: 0,
      teams: [],
      benchedIds: [],
    }
    saveLocalRound('g1', { id: 'local-one', createdAt: 5, config })
    const merged = importLegacyRounds('g1', [
      { id: 'server-one', createdAt: 9, config },
      { id: 'local-one', createdAt: 5, config },
    ])
    expect(merged?.map((round) => round.id)).toEqual(['server-one', 'local-one'])
    expect(wereLegacyRoundsImported('g1')).toBe(true)

    // A second load never duplicates or re-imports.
    expect(
      importLegacyRounds('g1', [{ id: 'server-two', createdAt: 10, config }]),
    ).toBeNull()
    expect(readLocalRounds('g1').map((round) => round.id)).toEqual([
      'server-one',
      'local-one',
    ])

    // An empty check still counts, so a fresh group is not queried every load.
    expect(importLegacyRounds('g2', [])).toBeNull()
    expect(wereLegacyRoundsImported('g2')).toBe(true)
  })

  test('device-local rosters are keyed by group', async () => {
    const first = createStore(false, 'group-a')
    const second = createStore(false, 'group-b')
    await first.addPlayers([{ name: 'Only A', skill: 5 }])
    expect((await first.players()).map((player) => player.name)).toEqual(['Only A'])
    expect(await second.players()).toEqual([])
  })
})