import { normalizeTags } from '../shared/roles'
import type { Player, Round, RoundConfig } from '../shared/types'

export type PlayerDraft = { name: string; skill: number; tags?: string[] }
export type PlayerPatch = Partial<
  Pick<Player, 'name' | 'skill' | 'tags' | 'sittingOut'>
>

export type Store = {
  players: () => Promise<Player[]>
  addPlayers: (drafts: PlayerDraft[]) => Promise<Player[]>
  updatePlayer: (id: string, patch: PlayerPatch) => Promise<Player>
  removePlayer: (id: string) => Promise<void>
  rounds: () => Promise<Round[]>
  addRound: (config: RoundConfig) => Promise<Round>
  removeRound: (id: string) => Promise<void>
}

const PLAYERS_KEY = 'teammaker.players.v1'
const ROUNDS_KEY = 'teammaker.rounds.v1'

function readLocal<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

function writeLocal<T>(key: string, value: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private browsing with no storage: the session still works, nothing persists.
  }
}

/** Used by the import prompt when a guest signs in on a device with a roster. */
export function readLocalPlayers(): Player[] {
  return readLocal<Player>(PLAYERS_KEY)
    .filter(
      (player) =>
        player &&
        typeof player.id === 'string' &&
        typeof player.name === 'string' &&
        Number.isInteger(player.skill),
    )
    .map((player) => ({ ...player, tags: normalizeTags(player.tags) }))
}

function localStore(): Store {
  return {
    async players() {
      return readLocal<Player>(PLAYERS_KEY)
    },
    async addPlayers(drafts) {
      const players = readLocal<Player>(PLAYERS_KEY)
      const now = Date.now()
      const created = drafts.map((draft, index) => ({
        id: crypto.randomUUID(),
        name: draft.name.trim().slice(0, 40),
        skill: Math.min(10, Math.max(1, Math.round(draft.skill))),
        tags: normalizeTags(draft.tags),
        sittingOut: false,
        createdAt: now + index,
        updatedAt: now + index,
      }))
      writeLocal(PLAYERS_KEY, [...players, ...created])
      return created
    },
    async updatePlayer(id, patch) {
      const players = readLocal<Player>(PLAYERS_KEY)
      const current = players.find((player) => player.id === id)
      if (!current) throw new Error('That player is no longer on the roster.')
      const next: Player = { ...current, ...patch, updatedAt: Date.now() }
      writeLocal(
        PLAYERS_KEY,
        players.map((player) => (player.id === id ? next : player)),
      )
      return next
    },
    async removePlayer(id) {
      writeLocal(
        PLAYERS_KEY,
        readLocal<Player>(PLAYERS_KEY).filter((player) => player.id !== id),
      )
    },
    async rounds() {
      return readLocal<Round>(ROUNDS_KEY)
    },
    async addRound(config) {
      const rounds = readLocal<Round>(ROUNDS_KEY)
      const round: Round = { id: crypto.randomUUID(), createdAt: Date.now(), config }
      writeLocal(ROUNDS_KEY, [round, ...rounds].slice(0, 60))
      return round
    },
    async removeRound(id) {
      writeLocal(
        ROUNDS_KEY,
        readLocal<Round>(ROUNDS_KEY).filter((round) => round.id !== id),
      )
    },
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => {
    throw new Error('Could not reach your workspace. Please try again.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function remoteStore(): Store {
  return {
    async players() {
      return (await request<{ players: Player[] }>('/api/players')).players
    },
    async addPlayers(drafts) {
      return (
        await request<{ players: Player[] }>(
          '/api/players',
          json('POST', { players: drafts }),
        )
      ).players
    },
    async updatePlayer(id, patch) {
      return (
        await request<{ player: Player }>(
          `/api/players/${id}`,
          json('PATCH', patch),
        )
      ).player
    },
    async removePlayer(id) {
      await request(`/api/players/${id}`, { method: 'DELETE' })
    },
    async rounds() {
      return (await request<{ rounds: Round[] }>('/api/rounds')).rounds
    },
    async addRound(config) {
      return (await request<{ round: Round }>('/api/rounds', json('POST', { config })))
        .round
    },
    async removeRound(id) {
      await request(`/api/rounds/${id}`, { method: 'DELETE' })
    },
  }
}

export function createStore(remote: boolean): Store {
  return remote ? remoteStore() : localStore()
}
