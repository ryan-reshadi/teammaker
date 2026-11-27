import {
  DEFAULT_K_FACTOR,
  clampElo,
  eloFromSkill,
  skillFromElo,
  type MatchInput,
  type MatchesResponse,
} from '../shared/elo'
import { normalizeTags } from '../shared/roles'
import {
  RIVALS_ACCEPTED_TYPES,
  RIVALS_MAX_BYTES,
  type RivalsScan,
} from '../shared/rivals'
import type { Player, Round, RoundConfig } from '../shared/types'

export type PlayerDraft = {
  name: string
  username?: string
  skill: number
  tags?: string[]
}
export type PlayerPatch = Partial<
  Pick<Player, 'name' | 'username' | 'skill' | 'elo' | 'tags' | 'sittingOut'>
>

export type RivalsConfig = {
  configured: boolean
  maxBytes: number
  acceptedTypes: readonly string[]
}

export type Store = {
  players: () => Promise<Player[]>
  addPlayers: (drafts: PlayerDraft[]) => Promise<Player[]>
  updatePlayer: (id: string, patch: PlayerPatch) => Promise<Player>
  removePlayer: (id: string) => Promise<void>
  matches: () => Promise<MatchesResponse>
  addMatch: (input: MatchInput) => Promise<Player[]>
  updateMatch: (id: string, input: MatchInput) => Promise<Player[]>
  moveMatch: (id: string, position: number) => Promise<Player[]>
  removeMatch: (id: string) => Promise<Player[]>
  setKFactor: (kFactor: number) => Promise<{ kFactor: number; players: Player[] }>
  rounds: () => Promise<Round[]>
  addRound: (config: RoundConfig) => Promise<Round>
  removeRound: (id: string) => Promise<void>
  rivalsConfig: () => Promise<RivalsConfig>
  scanRivals: (file: File) => Promise<RivalsScan>
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

/** Guests who rated players before elo existed start at skill x 100. */
function withElo(player: Player): Player {
  const elo = clampElo(
    Number.isFinite(player.elo) ? player.elo : (player.skill ?? 5) * 100,
  )
  return { ...player, elo, skill: skillFromElo(elo) }
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
    .map((player) => ({
      ...withElo(player),
      username:
        typeof player.username === 'string' ? player.username.slice(0, 32) : '',
      tags: normalizeTags(player.tags),
    }))
}

function localStore(): Store {
  const unsupported = async (): Promise<never> => {
    throw new Error('Sign in to track matches and tune elo.')
  }
  return {
    async players() {
      return readLocal<Player>(PLAYERS_KEY).map(withElo)
    },
    async addPlayers(drafts) {
      const players = readLocal<Player>(PLAYERS_KEY).map(withElo)
      const now = Date.now()
      const created = drafts.map((draft, index) => {
        const elo = eloFromSkill(Math.min(10, Math.max(1, Math.round(draft.skill))))
        return {
          id: crypto.randomUUID(),
          name: draft.name.trim().slice(0, 40),
          username: (draft.username ?? '').trim().slice(0, 32),
          skill: skillFromElo(elo),
          elo,
          tags: normalizeTags(draft.tags),
          sittingOut: false,
          createdAt: now + index,
          updatedAt: now + index,
        }
      })
      writeLocal(PLAYERS_KEY, [...players, ...created])
      return created
    },
    async updatePlayer(id, patch) {
      const players = readLocal<Player>(PLAYERS_KEY).map(withElo)
      const current = players.find((player) => player.id === id)
      if (!current) throw new Error('That player is no longer on the roster.')
      const next = withElo({ ...current, ...patch, updatedAt: Date.now() })
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
    matches: unsupported,
    addMatch: unsupported,
    updateMatch: unsupported,
    moveMatch: unsupported,
    removeMatch: unsupported,
    setKFactor: unsupported,
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
    async rivalsConfig() {
      return {
        configured: false,
        maxBytes: RIVALS_MAX_BYTES,
        acceptedTypes: [...RIVALS_ACCEPTED_TYPES],
      }
    },
    scanRivals: unsupported,
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
  const playerList = async (url: string, init: RequestInit) =>
    (await request<{ players: Player[] }>(url, init)).players
  return {
    async players() {
      return playerList('/api/players', { method: 'GET' })
    },
    async addPlayers(drafts) {
      return playerList('/api/players', json('POST', { players: drafts }))
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
    async matches() {
      return request<MatchesResponse>('/api/matches')
    },
    async addMatch(input) {
      return playerList('/api/matches', json('POST', input))
    },
    async updateMatch(id, input) {
      return playerList(`/api/matches/${id}`, json('PATCH', { input }))
    },
    async moveMatch(id, position) {
      return playerList(`/api/matches/${id}`, json('PATCH', { position }))
    },
    async removeMatch(id) {
      return playerList(`/api/matches/${id}`, { method: 'DELETE' })
    },
    async setKFactor(kFactor) {
      return request<{ kFactor: number; players: Player[] }>(
        '/api/settings',
        json('PUT', { kFactor }),
      )
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
    async rivalsConfig() {
      return request<RivalsConfig>('/api/rivals/config')
    },
    async scanRivals(file) {
      // A separate request path from the JSON routes: this one uploads an
      // image, so it must not share the 64 KB JSON body limit.
      const form = new FormData()
      form.append('image', file)
      const response = await fetch('/api/rivals/scan', {
        method: 'POST',
        body: form,
      })
      const body = (await response.json().catch(() => null)) as
        | (RivalsScan & { error?: string })
        | null
      if (!response.ok)
        throw new Error(
          body?.error || 'That screenshot could not be read. Please try again.',
        )
      if (!body)
        throw new Error('The screenshot service returned nothing. Please try again.')
      return body
    },
  }
}

export { DEFAULT_K_FACTOR }
export function createStore(remote: boolean): Store {
  return remote ? remoteStore() : localStore()
}
