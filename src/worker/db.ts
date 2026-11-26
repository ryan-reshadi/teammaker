import { normalizeTags } from '../shared/roles'
import type { Player, Round, RoundConfig } from '../shared/types'

/**
 * The slice of a SQLite driver this app uses. Cloudflare D1 satisfies it as-is
 * and `src/server/libsql.ts` implements it over libSQL, so routes never mention
 * a vendor type and the same queries run on either host.
 */
export type Statement = {
  bind(...values: unknown[]): Statement
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<unknown>
}

export type Database = {
  prepare(sql: string): Statement
  batch(statements: Statement[]): Promise<unknown>
}

const schema = [
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    skill INTEGER NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    sitting_out INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS players_owner ON players(owner_sub, created_at ASC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rounds_owner ON rounds(owner_sub, created_at DESC, id DESC)`,
]

// Workspaces created before role tags existed need the column added once.
const TAG_COLUMN = `ALTER TABLE players ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`

const ready = new WeakMap<Database, Promise<void>>()
export function ensureSchema(db: Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(async () => {
        const columns = await db
          .prepare('PRAGMA table_info(players)')
          .all<{ name: string }>()
        if (!columns.results.some((column) => column.name === 'tags'))
          await db.prepare(TAG_COLUMN).run()
      })
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

const parseTags = (value: string | null | undefined): string[] => {
  if (!value) return []
  try {
    return normalizeTags(JSON.parse(value))
  } catch {
    return []
  }
}

export type PlayerRow = {
  id: string
  name: string
  skill: number
  tags: string | null
  sitting_out: number
  created_at: number
  updated_at: number
}

export const mapPlayer = (row: PlayerRow): Player => ({
  id: row.id,
  name: row.name,
  skill: row.skill,
  tags: parseTags(row.tags),
  sittingOut: row.sitting_out === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export type RoundRow = {
  id: string
  config: string
  created_at: number
}

export const mapRound = (row: RoundRow): Round | null => {
  try {
    const config = JSON.parse(row.config) as RoundConfig
    if (!config || !Array.isArray(config.teams)) return null
    return {
      id: row.id,
      createdAt: row.created_at,
      config: {
        ...config,
        teams: config.teams.map((team) => ({
          ...team,
          players: (team.players ?? []).map((player) => ({
            ...player,
            tags: normalizeTags(player.tags),
          })),
        })),
      },
    }
  } catch {
    return null
  }
}
