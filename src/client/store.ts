import {
  DEFAULT_K_FACTOR,
  clampElo,
  eloFromSkill,
  ratingFromPatch,
  skillFromElo,
  type MatchInput,
  type MatchesResponse,
} from '../shared/elo'
import type { RivalsScan } from '../shared/rivals'
import type { Player } from '../shared/types'

export type PlayerDraft = {
  name: string
  username?: string
  skill: number
  tags?: string[]
}
export type PlayerPatch = Partial<
  Pick<Player, 'name' | 'username' | 'skill' | 'elo' | 'tags'>
>

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
  /**
   * Reads a scoreboard screenshot on this device. `onProgress` carries the
   * engine's loading and reading messages straight to the panel.
   */
  scanRivals: (
    file: File,
    onProgress?: (message: string) => void,
    signal?: AbortSignal,
  ) => Promise<RivalsScan>
}

const LEGACY_PLAYERS_KEY = 'teammaker.players.v1'

const localKey = (groupId: string) =>
  groupId === 'local' ? LEGACY_PLAYERS_KEY : `teammaker.players.v2:${groupId}`

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

const cleanTags = (value?: string[]): string[] =>
  [...new Set((value ?? []).filter((tag) => typeof tag === 'string'))]

/** Used by the import prompt when a guest signs in on a device with a roster. */
export function readLocalPlayers(): Player[] {
  return readLocal<Player>(LEGACY_PLAYERS_KEY)
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
      tags: cleanTags(player.tags),
    }))
}

function localStore(groupId: string): Store {
  const key = localKey(groupId)
  const unsupported = async (): Promise<never> => {
    throw new Error('Sign in to track matches and tune elo.')
  }
  return {
    async players() {
      return readLocal<Player>(key).map(withElo)
    },
    async addPlayers(drafts) {
      const players = readLocal<Player>(key).map(withElo)
      const now = Date.now()
      const created = drafts.map((draft, index) => {
        const elo = eloFromSkill(Math.min(10, Math.max(1, Math.round(draft.skill))))
        return {
          id: crypto.randomUUID(),
          name: draft.name.trim().slice(0, 40),
          username: (draft.username ?? '').trim().slice(0, 32),
          skill: skillFromElo(elo),
          elo,
          tags: cleanTags(draft.tags),
          createdAt: now + index,
          updatedAt: now + index,
        }
      })
      writeLocal(key, [...players, ...created])
      return created
    },
    async updatePlayer(id, patch) {
      const players = readLocal<Player>(key).map(withElo)
      const current = players.find((player) => player.id === id)
      if (!current) throw new Error('That player is no longer on the roster.')
      // The 1-10 control sends a skill-only patch, and elo is the stored
      // rating: convert it the way the remote route does. An explicit elo wins.
      const next: Player = {
        ...current,
        ...patch,
        ...ratingFromPatch(current, patch),
        updatedAt: Date.now(),
      }
      writeLocal(
        key,
        players.map((player) => (player.id === id ? next : player)),
      )
      return next
    },
    async removePlayer(id) {
      writeLocal(
        key,
        readLocal<Player>(key).filter((player) => player.id !== id),
      )
    },
    async matches() {
      // Device-only mode has no match log by design: guests rate by hand and
      // nothing is replayed.
      return { kFactor: DEFAULT_K_FACTOR, events: [], squashed: null }
    },
    addMatch: unsupported,
    updateMatch: unsupported,
    moveMatch: unsupported,
    removeMatch: unsupported,
    setKFactor: unsupported,
    async scanRivals(file, onProgress, signal) {
      const { scanScreenshot } = await import('./ocr')
      return scanScreenshot(file, onProgress, { signal })
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

function remoteStore(groupId: string): Store {
  const base = `/api/groups/${encodeURIComponent(groupId)}`
  const playerList = async (url: string, init: RequestInit) =>
    (await request<{ players: Player[] }>(url, init)).players
  return {
    async players() {
      return playerList(`${base}/players`, { method: 'GET' })
    },
    async addPlayers(drafts) {
      return playerList(`${base}/players`, json('POST', { players: drafts }))
    },
    async updatePlayer(id, patch) {
      return (
        await request<{ player: Player }>(
          `${base}/players/${encodeURIComponent(id)}`,
          json('PATCH', patch),
        )
      ).player
    },
    async removePlayer(id) {
      await request(`${base}/players/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async matches() {
      return request<MatchesResponse>(`${base}/matches`)
    },
    async addMatch(input) {
      return playerList(`${base}/matches`, json('POST', input))
    },
    async updateMatch(id, input) {
      return playerList(`${base}/matches/${encodeURIComponent(id)}`, json('PATCH', { input }))
    },
    async moveMatch(id, position) {
      return playerList(`${base}/matches/${encodeURIComponent(id)}`, json('PATCH', { position }))
    },
    async removeMatch(id) {
      return playerList(`${base}/matches/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async setKFactor(kFactor) {
      return request<{ kFactor: number; players: Player[] }>(
        `${base}/settings`,
        json('PUT', { kFactor }),
      )
    },
    async scanRivals(file, onProgress, signal) {
      // The whole scan runs in this tab: the screenshot never leaves the device,
      // so there is no service to keep running and no per-import cost.
      const { scanScreenshot } = await import('./ocr')
      return scanScreenshot(file, onProgress, { signal })
    },
  }
}

export { DEFAULT_K_FACTOR }
export function createStore(remote: boolean, groupId = 'local'): Store {
  return remote ? remoteStore(groupId) : localStore(groupId)
}
