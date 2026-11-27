import { beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from '../src/client/store'
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

  test('name and sit-out patches leave the rating alone', async () => {
    const { store, player } = await seeded()
    await store.updatePlayer(player.id, { elo: 512 })
    const renamed = await store.updatePlayer(player.id, { name: 'Ada Lovelace' })
    expect(renamed.elo).toBe(512)
    expect(renamed.skill).toBe(5)
    const sitting = await store.updatePlayer(player.id, { sittingOut: true })
    expect(sitting.elo).toBe(512)
    expect(sitting.skill).toBe(5)
    expect(sitting.sittingOut).toBe(true)
  })
})