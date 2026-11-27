/**
 * Read-only preview of a K change over the legacy (v1) part of the log.
 *
 *   bun run preview:replay [dbPath] [owner] [proposedK]
 *
 * The local D1 file is discovered automatically. Nothing is written: the
 * database is opened read-only and only SELECTs run.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_K_FACTOR,
  isKFactor,
  replay,
  type MatchInput,
  type RatingEvent,
} from '../src/shared/elo'

const localDatabase = (): string | null => {
  const directory = join('.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  if (!existsSync(directory)) return null
  const file = readdirSync(directory).find(
    (name) => name.endsWith('.sqlite') && !name.startsWith('metadata'),
  )
  return file ? join(directory, file) : null
}

const args = process.argv.slice(2)
const dbPath = args[0] ?? localDatabase()
const owner = args[1] ?? 'local-preview'
const proposedK = Number(args[2] ?? '')

if (!dbPath || !existsSync(dbPath)) {
  console.error('No database found. Pass a D1 SQLite path or run the local dev server first.')
  process.exit(1)
}
if (!isKFactor(proposedK)) {
  console.error(
    'Pass a proposed K from 8 to 64, for example: bun run preview:replay <dbPath> <owner> 64',
  )
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
try {
  const players = db
    .query('SELECT id, name, base_elo FROM players WHERE owner_sub = ? ORDER BY name')
    .all(owner) as { id: string; name: string; base_elo: number }[]
  const rows = db
    .query(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE owner_sub = ? ORDER BY position, created_at, id',
    )
    .all(owner) as {
    id: string
    position: number
    kind: string
    payload: string
    created_at: number
    updated_at: number
  }[]
  const settings = db
    .query('SELECT k_factor FROM settings WHERE owner_sub = ?')
    .get(owner) as { k_factor: number } | null
  const meta = db
    .query('SELECT legacy_k FROM rating_meta WHERE owner_sub = ?')
    .get(owner) as { legacy_k: number } | null

  const currentK =
    settings && isKFactor(settings.k_factor) ? settings.k_factor : DEFAULT_K_FACTOR
  const legacyK = meta && isKFactor(meta.legacy_k) ? meta.legacy_k : currentK
  const events: RatingEvent[] = []
  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (row.kind === 'match')
      events.push({
        id: row.id,
        position: row.position,
        kind: 'match',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: payload as MatchInput,
      })
    else if (row.kind === 'adjust') {
      const adjust = payload as { playerId?: unknown; elo?: unknown; reason?: unknown }
      if (typeof adjust.playerId !== 'string' || typeof adjust.elo !== 'number') continue
      events.push({
        id: row.id,
        position: row.position,
        kind: 'adjust',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: {
          playerId: adjust.playerId,
          elo: adjust.elo,
          reason: typeof adjust.reason === 'string' ? adjust.reason : '',
        },
      })
    }
  }

  const roster = players.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo,
  }))
  const current = replay(events, roster, currentK, legacyK)
  const proposed = replay(events, roster, proposedK, proposedK)

  console.log(`Database: ${dbPath}`)
  console.log(`Owner:    ${owner}`)
  console.log(
    `K:        current ${currentK}, legacy ${legacyK}, proposed ${proposedK}`,
  )
  console.log('v2 events keep their recorded K; only legacy events use the proposal.')
  console.log('')
  console.log('Player'.padEnd(24), 'current'.padStart(8), 'proposed'.padStart(9), 'diff'.padStart(7))
  for (const player of roster) {
    const before = current.elos.get(player.id) ?? player.baseElo
    const after = proposed.elos.get(player.id) ?? player.baseElo
    const diff = after - before
    console.log(
      player.name.slice(0, 23).padEnd(24),
      String(before).padStart(8),
      String(after).padStart(9),
      `${diff > 0 ? '+' : ''}${diff}`.padStart(7),
    )
  }
} finally {
  db.close()
}