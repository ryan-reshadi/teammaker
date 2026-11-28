import { clampElo, skillFromElo } from '../shared/elo'
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
  // A group is the shared workspace: one roster, one rating log, one tag list.
  `CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    owner_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    k_factor INTEGER NOT NULL DEFAULT 32,
    rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS groups_owner ON groups(owner_sub, deleted_at)`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    user_sub TEXT NOT NULL,
    role TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_sub)
  )`,
  `CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_sub)`,
  // Only a hash of the invite token is stored, so a database leak cannot be
  // replayed as a working invite.
  `CREATE TABLE IF NOT EXISTS group_invites (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_sub TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    expires_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS group_invites_group ON group_invites(group_id, revoked_at)`,
  // Tag ids are scoped to their group, which lets a migrated legacy role keep
  // its id and a custom tag use any short slug.
  `CREATE TABLE IF NOT EXISTS group_tags (
    group_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    short TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS group_tags_order ON group_tags(group_id, sort, id)`,
  // A player can be held by several accounts (alternate emails), and the same
  // email may sit on more than one player. The email is a label for who someone
  // is, never an authorization key: access stays keyed on the account sub.
  `CREATE TABLE IF NOT EXISTS group_player_emails (
    group_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    email TEXT NOT NULL,
    added_by_sub TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, player_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS player_emails_player ON group_player_emails(group_id, player_id)`,
  `CREATE INDEX IF NOT EXISTS player_emails_email ON group_player_emails(group_id, email)`,
  // A claim on a roster player, or a proposal to add one. Members file them;
  // editors apply or dismiss them. Applying is the only way a request changes
  // the roster.
  `CREATE TABLE IF NOT EXISTS group_player_requests (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    requester_sub TEXT NOT NULL,
    requester_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    kind TEXT NOT NULL,
    player_id TEXT,
    name TEXT,
    username TEXT,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by_sub TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS player_requests_group ON group_player_requests(group_id, status, created_at)`,
  // One open request per member per group.
  `CREATE UNIQUE INDEX IF NOT EXISTS player_requests_pending ON group_player_requests(group_id, requester_sub) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    skill INTEGER NOT NULL,
    elo INTEGER NOT NULL DEFAULT 0,
    base_elo INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    sitting_out INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS players_owner ON players(owner_sub, created_at ASC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rounds_owner ON rounds(owner_sub, created_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS rating_events (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rating_events_owner ON rating_events(owner_sub, position ASC, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS rating_results (
    event_id TEXT NOT NULL,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    slot TEXT NOT NULL,
    player_id TEXT,
    name TEXT NOT NULL,
    elo_before INTEGER NOT NULL,
    elo_after INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    PRIMARY KEY (event_id, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS rating_results_player ON rating_results(owner_sub, player_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
    owner_sub TEXT PRIMARY KEY,
    k_factor INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // The K that produced ratings written before formula versioning. It is
  // pinned lazily, so existing history is never replayed or rewritten by a
  // schema step.
  `CREATE TABLE IF NOT EXISTS rating_meta (
    owner_sub TEXT PRIMARY KEY,
    legacy_k INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Per-group copies of the two account-level bookkeeping rows above.
  `CREATE TABLE IF NOT EXISTS group_rating_meta (
    group_id TEXT PRIMARY KEY,
    legacy_k INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // What a squash removed, and when. Nothing replays from it: it only lets the
  // match list say why older history is missing.
  `CREATE TABLE IF NOT EXISTS log_squashes (
    owner_sub TEXT PRIMARY KEY,
    removed INTEGER NOT NULL,
    squashed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_squashes (
    group_id TEXT PRIMARY KEY,
    removed INTEGER NOT NULL,
    squashed_at INTEGER NOT NULL
  )`,
]

export const REQUIRED_TABLES = [
  'players',
  'rounds',
  'rating_events',
  'rating_results',
  'settings',
  'rating_meta',
  'log_squashes',
  'groups',
  'group_members',
  'group_invites',
  'group_tags',
  'group_player_emails',
  'group_player_requests',
  'group_rating_meta',
  'group_squashes',
] as const

const TAG_COLUMN = `ALTER TABLE players ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`
const USERNAME_COLUMN = `ALTER TABLE players ADD COLUMN username TEXT NOT NULL DEFAULT ''`
const ELO_COLUMN = `ALTER TABLE players ADD COLUMN elo INTEGER NOT NULL DEFAULT 0`
const BASE_ELO_COLUMN = `ALTER TABLE players ADD COLUMN base_elo INTEGER NOT NULL DEFAULT 0`
// A removed player is archived, never deleted: the row still seeds the rating
// replay, so nobody else's history shifts. NULL means the player is on the
// roster.
const DELETED_AT_COLUMN = `ALTER TABLE players ADD COLUMN deleted_at INTEGER`

const GROUP_COLUMNS = [
  ['players', 'group_id TEXT'],
  ['rating_events', 'group_id TEXT'],
  ['rating_results', 'group_id TEXT'],
  ['rounds', 'group_id TEXT'],
  ['log_squashes', 'group_id TEXT'],
] as const

const TABLES = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(
  (table) => `'${table}'`,
).join(', ')})`
// A table-valued function rather than `PRAGMA table_info`: it is an ordinary
// SELECT, so it stays valid on hosts that only proxy plain queries.
const COLUMNS = "SELECT name FROM pragma_table_info('players')"

/**
 * Workspaces created before role tags or elo existed need the columns added
 * once. Existing players start from their old 1-10 rating (skill x 100) so no
 * history is invented.
 */
const ensureColumns = async (db: Database): Promise<void> => {
  const columns = await db.prepare(COLUMNS).all<{ name: string }>()
  const names = new Set(columns.results.map((column) => column.name))
  const missing: string[] = []
  if (!names.has('tags')) missing.push(TAG_COLUMN)
  if (!names.has('username')) missing.push(USERNAME_COLUMN)
  if (!names.has('elo')) missing.push(ELO_COLUMN)
  if (!names.has('base_elo')) missing.push(BASE_ELO_COLUMN)
  if (!names.has('deleted_at')) missing.push(DELETED_AT_COLUMN)
  if (missing.length > 0) await db.batch(missing.map((sql) => db.prepare(sql)))
  if (!names.has('elo') || !names.has('base_elo')) {
    await db
      .prepare(
        'UPDATE players SET elo = skill * 100, base_elo = skill * 100 WHERE elo = 0',
      )
      .run()
  }
  await ensureGroupColumns(db)
}

/** Adds the per-group foreign keys to databases created before groups. */
const ensureGroupColumns = async (db: Database): Promise<void> => {
  const statements: Statement[] = []
  for (const [table, column] of GROUP_COLUMNS) {
    const info = await db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all<{ name: string }>()
    if (!info.results.some((entry) => entry.name === 'group_id'))
      statements.push(db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column}`))
  }
  if (statements.length > 0) await db.batch(statements)
}

/**
 * Indexes over `group_id` run after the column guard: a database created before
 * groups keeps its old `players` table, so creating the index in the same batch
 * as `CREATE TABLE IF NOT EXISTS` would reference a column that only exists
 * after `ALTER TABLE`.
 */
const groupIndexes = [
  `CREATE INDEX IF NOT EXISTS players_group ON players(group_id, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS rounds_group ON rounds(group_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS rating_events_group ON rating_events(group_id, position ASC, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS rating_results_group ON rating_results(group_id, event_id)`,
]

const bootstrap = async (db: Database): Promise<void> => {
  // Read before writing: a remote database charges a write transaction (and a
  // lock on the primary) for every CREATE TABLE IF NOT EXISTS, while a local
  // file makes that free. A cold start on a healthy database should only read.
  const tables = await db.prepare(TABLES).all<{ name: string }>()
  if (tables.results.length < REQUIRED_TABLES.length) {
    await db.batch(schema.map((sql) => db.prepare(sql)))
  }
  await ensureColumns(db)
  await db.batch(groupIndexes.map((sql) => db.prepare(sql)))
}

const ready = new WeakMap<Database, Promise<void>>()
export function ensureSchema(db: Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = bootstrap(db).catch(async (error) => {
      // A remote database serialises writes, so two instances booting at once
      // can see SQLITE_BUSY before either has created the tables. One retry
      // covers that; a local file never contends with itself.
      console.warn(
        'Teammaker: schema bootstrap failed, retrying once',
        error instanceof Error ? error.message : error,
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      try {
        await bootstrap(db)
      } catch (retryError) {
        ready.delete(db)
        throw retryError
      }
    })
    ready.set(db, pending)
  }
  return pending
}

const parseTags = (
  value: string | null | undefined,
  allowed?: readonly string[],
): string[] => {
  if (!value) return []
  try {
    return normalizeTags(JSON.parse(value), allowed)
  } catch {
    return []
  }
}

export type PlayerRow = {
  id: string
  name: string
  username: string | null
  skill: number
  elo: number
  tags: string | null
  sitting_out: number
  /** Set when the player was removed from the roster; they stay in the log. */
  deleted_at?: number | null
  created_at: number
  updated_at: number
}

export const mapPlayer = (
  row: PlayerRow,
  allowedTags?: readonly string[],
  emails?: readonly string[],
): Player => ({
  id: row.id,
  name: row.name,
  username: row.username ?? '',
  skill: skillFromElo(row.elo),
  elo: row.elo,
  tags: parseTags(row.tags, allowedTags),
  emails: [...(emails ?? [])],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export type RoundRow = {
  id: string
  config: string
  created_at: number
}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

/**
 * Saved rounds are snapshots. Rounds saved before elo existed carry 1-10 sums,
 * so they are scaled to the elo scale as they are read; names stay as they were
 * so history keeps reading correctly after a rename.
 */
export const mapRound = (row: RoundRow): Round | null => {
  try {
    const config = JSON.parse(row.config) as Record<string, unknown>
    if (!config || !Array.isArray(config.teams)) return null
    const legacy = config.version !== 2
    const teams = config.teams.map((team) => {
      const entry = (team ?? {}) as Record<string, unknown>
      const players = Array.isArray(entry.players) ? entry.players : []
      return {
        sum: (Number(entry.sum) || 0) * (legacy ? 100 : 1),
        players: players.map((player) => {
          const raw = (player ?? {}) as Record<string, unknown>
          return {
            id: asString(raw.id),
            name: asString(raw.name),
            elo: clampElo(legacy ? (Number(raw.skill) || 1) * 100 : Number(raw.elo)),
            tags: normalizeTags(raw.tags),
          }
        }),
      }
    })
    const benchedIds = Array.isArray(config.benchedIds)
      ? config.benchedIds.filter((id): id is string => typeof id === 'string')
      : []
    return {
      id: row.id,
      createdAt: row.created_at,
      config: {
        version: 2,
        teamCount: Number(config.teamCount) || 1,
        tolerance: (Number(config.tolerance) || 0) * (legacy ? 100 : 1),
        spread: (Number(config.spread) || 0) * (legacy ? 100 : 1),
        teams,
        benchedIds,
      } satisfies RoundConfig,
    }
  } catch {
    return null
  }
}
