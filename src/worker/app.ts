import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  DEFAULT_K_FACTOR,
  MAX_DAMAGE,
  MAX_EVENTS,
  MAX_MATCH_PLAYERS,
  clampElo,
  isKFactor,
  replay,
  skillFromElo,
  type AdjustInput,
  type MatchEventView,
  type MatchInput,
  type MatchPlayerInput,
  type MatchRoster,
  type MatchTeamInput,
  type RatingEvent,
  type RatingEventView,
  type ReplayResult,
} from '../shared/elo'
import { normalizeTags, ROLE_IDS } from '../shared/roles'
import type { Player, RoundConfig } from '../shared/types'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import {
  ensureSchema,
  mapPlayer,
  mapRound,
  type Database,
  type PlayerRow,
  type RoundRow,
  type Statement,
} from './db'

type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: Database }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

const ROSTER_LIMIT = 200
const MAX_BATCH = 50
const MAX_ROUNDS = 100
const MAX_LABEL = 60
const MAX_REASON = 80

const readName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 40 ? name : null
}

const readSkill = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10
    ? value
    : null

const readElo = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 1000
    ? value
    : null

/** Absent tags mean none; unknown or duplicate ids are rejected rather than dropped. */
const readTags = (value: unknown): string[] | null => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ROLE_IDS.length) return null
  for (const item of value)
    if (typeof item !== 'string' || !ROLE_IDS.includes(item)) return null
  return normalizeTags(value)
}

type Draft = { name: string; skill: number; tags: string[] }

function readDrafts(body: unknown): Draft[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const list = 'players' in record ? record.players : [record]
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
    return null
  const drafts: Draft[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (
      Object.keys(entry).some(
        (key) => key !== 'name' && key !== 'skill' && key !== 'tags',
      )
    )
      return null
    const name = readName(entry.name)
    const skill = readSkill(entry.skill)
    const tags = readTags(entry.tags)
    if (!name || skill === null || !tags) return null
    drafts.push({ name, skill, tags })
  }
  return drafts
}

function readMatchInput(value: unknown): MatchInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => key !== 'label' && key !== 'teams' && key !== 'winner',
    )
  )
    return null
  const label =
    record.label === undefined
      ? ''
      : typeof record.label === 'string' && record.label.trim().length <= MAX_LABEL
        ? record.label.trim()
        : null
  if (label === null) return null
  if (!Array.isArray(record.teams) || record.teams.length !== 2) return null
  if (record.winner !== 0 && record.winner !== 1) return null

  const seen = new Set<string>()
  const teams: MatchTeamInput[] = []
  let tracked = 0
  let totalDamage = 0
  for (const rawTeam of record.teams) {
    if (!rawTeam || typeof rawTeam !== 'object' || Array.isArray(rawTeam))
      return null
    const team = rawTeam as Record<string, unknown>
    if (Object.keys(team).some((key) => key !== 'players')) return null
    if (
      !Array.isArray(team.players) ||
      team.players.length < 1 ||
      team.players.length > MAX_MATCH_PLAYERS
    )
      return null
    const players: MatchPlayerInput[] = []
    for (const rawPlayer of team.players) {
      if (
        !rawPlayer ||
        typeof rawPlayer !== 'object' ||
        Array.isArray(rawPlayer)
      )
        return null
      const player = rawPlayer as Record<string, unknown>
      if (
        Object.keys(player).some(
          (key) => key !== 'id' && key !== 'name' && key !== 'damage' && key !== 'tracked',
        )
      )
        return null
      if (
        typeof player.id !== 'string' ||
        player.id.length < 1 ||
        player.id.length > 64 ||
        seen.has(player.id)
      )
        return null
      seen.add(player.id)
      const name = readName(player.name)
      if (!name) return null
      if (
        typeof player.damage !== 'number' ||
        !Number.isInteger(player.damage) ||
        player.damage < 0 ||
        player.damage > MAX_DAMAGE
      )
        return null
      if (typeof player.tracked !== 'boolean') return null
      if (player.tracked) tracked++
      totalDamage += player.damage
      players.push({
        id: player.id,
        name,
        damage: player.damage,
        tracked: player.tracked,
      })
    }
    teams.push({ players })
  }
  if (tracked === 0 || totalDamage === 0) return null
  return { label, teams, winner: record.winner }
}

function readTeams(value: unknown): RoundConfig['teams'] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null
  const teams: RoundConfig['teams'] = []
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const team = item as Record<string, unknown>
    if (!Array.isArray(team.players) || team.players.length > ROSTER_LIMIT)
      return null
    if (typeof team.sum !== 'number' || !Number.isFinite(team.sum)) return null
    const players: RoundConfig['teams'][number]['players'] = []
    for (const raw of team.players) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const player = raw as Record<string, unknown>
      if (typeof player.id !== 'string' || player.id.length > 64) return null
      const name = readName(player.name)
      const elo = readElo(player.elo)
      const tags = readTags(player.tags)
      if (!name || elo === null || !tags) return null
      players.push({ id: player.id, name, elo, tags })
    }
    total += players.length
    if (total > ROSTER_LIMIT * 2) return null
    teams.push({ players, sum: team.sum })
  }
  return teams
}

function readRoundConfig(value: unknown): RoundConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as Record<string, unknown>
  if (
    Object.keys(config).some(
      (key) =>
        !['version', 'teamCount', 'tolerance', 'spread', 'teams', 'benchedIds'].includes(
          key,
        ),
    )
  )
    return null
  if (config.version !== 2) return null
  const { teamCount, tolerance, spread } = config
  if (
    typeof teamCount !== 'number' ||
    !Number.isInteger(teamCount) ||
    teamCount < 1 ||
    teamCount > 8
  )
    return null
  if (
    typeof tolerance !== 'number' ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 5000
  )
    return null
  if (
    typeof spread !== 'number' ||
    !Number.isFinite(spread) ||
    spread < 0 ||
    spread > 10000
  )
    return null
  const teams = readTeams(config.teams)
  if (!teams || teams.length !== teamCount) return null
  const benchedIds = Array.isArray(config.benchedIds)
    ? config.benchedIds
        .filter((id): id is string => typeof id === 'string' && id.length <= 64)
        .slice(0, ROSTER_LIMIT)
    : []
  return { version: 2, teamCount, tolerance, spread, teams, benchedIds }
}

type EventRow = {
  id: string
  position: number
  kind: string
  payload: string
  created_at: number
  updated_at: number
}

type ResultRow = {
  event_id: string
  slot: string
  player_id: string | null
  name: string
  elo_before: number
  elo_after: number
  delta: number
}

type BaseRow = PlayerRow & { base_elo: number }

async function loadEvents(db: Database, owner: string): Promise<RatingEvent[]> {
  const rows = await db
    .prepare(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE owner_sub = ? ORDER BY position ASC, created_at ASC, id ASC',
    )
    .bind(owner)
    .all<EventRow>()
  const events: RatingEvent[] = []
  for (const row of rows.results) {
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
    else if (row.kind === 'adjust')
      events.push({
        id: row.id,
        position: row.position,
        kind: 'adjust',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: payload as AdjustInput,
      })
  }
  return events
}

async function getKFactor(db: Database, owner: string): Promise<number> {
  const row = await db
    .prepare('SELECT k_factor FROM settings WHERE owner_sub = ?')
    .bind(owner)
    .first<{ k_factor: number }>()
  return row && isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR
}

async function nextPosition(db: Database, owner: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM rating_events WHERE owner_sub = ?',
    )
    .bind(owner)
    .first<{ next: number }>()
  return row?.next ?? 0
}

async function findEvent(
  db: Database,
  owner: string,
  id: string,
): Promise<EventRow | null> {
  return db
    .prepare(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE id = ? AND owner_sub = ?',
    )
    .bind(id, owner)
    .first<EventRow>()
}

const insertResultSql =
  'INSERT INTO rating_results (event_id, owner_sub, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

/**
 * Rebuilds every rating from the log (a player's creation elo plus each event in
 * order), then writes the affected bookkeeping rows. `from` is the earliest
 * position whose outcome can have changed: an appended event needs one row set,
 * while a K change replays the whole history.
 */
async function recompute(
  db: Database,
  owner: string,
  from: number,
): Promise<Player[]> {
  const players = await db
    .prepare(
      'SELECT id, name, skill, elo, tags, sitting_out, created_at, updated_at, base_elo FROM players WHERE owner_sub = ? ORDER BY created_at ASC, id ASC',
    )
    .bind(owner)
    .all<BaseRow>()
  const events = await loadEvents(db, owner)
  const kFactor = await getKFactor(db, owner)
  const roster: MatchRoster[] = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo,
  }))
  const { elos, outcomes }: ReplayResult = replay(events, roster, kFactor)

  const statements: Statement[] = []
  for (const player of players.results) {
    const elo = elos.get(player.id) ?? player.elo
    const skill = skillFromElo(elo)
    if (elo !== player.elo || skill !== player.skill)
      statements.push(
        db
          .prepare('UPDATE players SET elo = ?, skill = ? WHERE id = ? AND owner_sub = ?')
          .bind(elo, skill, player.id, owner),
      )
  }

  statements.push(
    db
      .prepare(
        'DELETE FROM rating_results WHERE owner_sub = ? AND event_id IN (SELECT id FROM rating_events WHERE owner_sub = ? AND position >= ?)',
      )
      .bind(owner, owner, from),
  )

  const names = new Map(players.results.map((player) => [player.id, player.name]))
  for (const event of events) {
    if (event.position < from) continue
    const outcome = outcomes.get(event.id)
    if (!outcome) continue
    if (outcome.kind === 'match') {
      outcome.result.teams.forEach((team, teamIndex) => {
        team.players.forEach((player, slot) => {
          statements.push(
            db
              .prepare(insertResultSql)
              .bind(
                event.id,
                owner,
                `${teamIndex}:${slot}`,
                player.id,
                player.name,
                player.eloBefore,
                player.eloAfter,
                player.delta,
              ),
          )
        })
      })
      continue
    }
    const { playerId, eloBefore, eloAfter } = outcome.result
    statements.push(
      db
        .prepare(insertResultSql)
        .bind(
          event.id,
          owner,
          '0',
          playerId,
          names.get(playerId) ?? '',
          eloBefore,
          eloAfter,
          eloAfter - eloBefore,
        ),
    )
  }

  if (statements.length > 0) await db.batch(statements)

  return players.results.map((player) =>
    mapPlayer({
      ...player,
      elo: elos.get(player.id) ?? player.elo,
      skill: skillFromElo(elos.get(player.id) ?? player.elo),
    }),
  )
}

async function matchViews(
  db: Database,
  owner: string,
): Promise<RatingEventView[]> {
  const events = await loadEvents(db, owner)
  const rows = await db
    .prepare(
      'SELECT event_id, slot, player_id, name, elo_before, elo_after, delta FROM rating_results WHERE owner_sub = ?',
    )
    .bind(owner)
    .all<ResultRow>()
  const results = new Map(
    rows.results.map((row) => [`${row.event_id}|${row.slot}`, row]),
  )

  return events.map((event): RatingEventView => {
    if (event.kind === 'adjust') {
      const row = results.get(`${event.id}|0`)
      return {
        id: event.id,
        kind: 'adjust',
        position: event.position,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        playerId: event.payload.playerId,
        name: row?.name ?? '',
        reason: event.payload.reason,
        eloBefore: row?.elo_before ?? event.payload.elo,
        eloAfter: row?.elo_after ?? event.payload.elo,
        delta: row?.delta ?? 0,
      }
    }
    const teams = event.payload.teams.map((team, teamIndex) => ({
      players: team.players.map((player, slot) => {
        const row = results.get(`${event.id}|${teamIndex}:${slot}`)
        return {
          id: player.tracked ? player.id : null,
          name: row?.name ?? player.name,
          damage: player.damage,
          tracked: player.tracked,
          elo: row?.elo_before ?? 0,
          eloBefore: row?.elo_before ?? 0,
          eloAfter: row?.elo_after ?? 0,
          delta: row?.delta ?? 0,
        }
      }),
    }))
    return {
      id: event.id,
      kind: 'match',
      position: event.position,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      label: event.payload.label,
      winner: event.payload.winner,
      teams,
    } satisfies MatchEventView
  })
}

async function trackedIdsExist(
  db: Database,
  owner: string,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return true
  const rows = await db
    .prepare(
      `SELECT id FROM players WHERE owner_sub = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(owner, ...ids)
    .all<{ id: string }>()
  return rows.results.length === new Set(ids).size
}

/** Tests inject identities; production always uses the Freebuff SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()
  // Reachability probe: one real round trip, no authentication, no rows written.
  // It answers the question the session flag cannot — `session.database` only
  // says a URL was configured, not that the database answers.
  app.get('/api/health', async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const db = c.env.DB
    if (!db) return c.json({ ok: true, database: 'unconfigured' })
    try {
      await db.prepare('SELECT 1 AS ok').first<{ ok: number }>()
      const tables = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('players', 'rounds', 'rating_events', 'rating_results', 'settings')",
        )
        .all<{ name: string }>()
      return c.json({
        ok: true,
        database: 'ok',
        schema: tables.results.length === 5 ? 'ready' : 'missing',
      })
    } catch (error) {
      // The driver's message can name the host; it is not a secret, but keep it
      // in the function logs rather than the public response.
      console.error(
        'Teammaker: database health check failed',
        error instanceof Error ? error.message : error,
      )
      return c.json({ ok: false, database: 'unreachable' }, 503)
    }
  })
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  )
  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  // Every data route needs a signed-in user, a same-origin mutation and a database.
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/session')
      return next()
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  })

  app.get('/api/players', async (c) => {
    const result = await c
      .get('db')
      .prepare(
        'SELECT id, name, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE owner_sub = ? ORDER BY created_at ASC, id ASC',
      )
      .bind(c.get('user').sub)
      .all<PlayerRow>()
    return c.json({ players: result.results.map(mapPlayer) })
  })

  app.post('/api/players', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const drafts = readDrafts(body)
    if (!drafts)
      return c.json(
        { error: 'Each player needs a name and a skill from 1 to 10.' },
        400,
      )
    const db = c.get('db')
    const owner = c.get('user').sub
    const existing = await db
      .prepare('SELECT COUNT(*) AS total FROM players WHERE owner_sub = ?')
      .bind(owner)
      .first<{ total: number }>()
    if ((existing?.total ?? 0) + drafts.length > ROSTER_LIMIT)
      return c.json({ error: 'A roster holds up to 200 players.' }, 400)
    const createdAt = Date.now()
    const players: Player[] = drafts.map((draft, index) => ({
      id: crypto.randomUUID(),
      name: draft.name,
      skill: draft.skill,
      elo: clampElo(draft.skill * 100),
      tags: draft.tags,
      sittingOut: false,
      createdAt: createdAt + index,
      updatedAt: createdAt + index,
    }))
    await db.batch(
      players.map((player) =>
        db
          .prepare(
            'INSERT INTO players (id, owner_sub, name, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
          )
          .bind(
            player.id,
            owner,
            player.name,
            player.skill,
            player.elo,
            player.elo,
            JSON.stringify(player.tags),
            player.createdAt,
            player.updatedAt,
          ),
      ),
    )
    return c.json({ players }, 201)
  })

  app.patch('/api/players/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some(
        (key) => !['name', 'skill', 'elo', 'tags', 'sittingOut'].includes(key),
      )
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    const id = c.req.param('id')
    const db = c.get('db')
    const owner = c.get('user').sub
    const current = await db
      .prepare('SELECT id, elo FROM players WHERE id = ? AND owner_sub = ?')
      .bind(id, owner)
      .first<{ id: string; elo: number }>()
    if (!current) return c.json({ error: 'Player not found.' }, 404)

    const sets: string[] = []
    const values: unknown[] = []
    let targetElo: number | null = null
    let reason = 'Manual rating'
    if ('name' in patch) {
      const name = readName(patch.name)
      if (!name) return c.json({ error: 'Names are 1 to 40 characters.' }, 400)
      sets.push('name = ?')
      values.push(name)
    }
    if ('skill' in patch && 'elo' in patch)
      return c.json({ error: 'Set either the 1-10 rating or elo, not both.' }, 400)
    if ('skill' in patch) {
      const skill = readSkill(patch.skill)
      if (skill === null)
        return c.json({ error: 'Skills are whole numbers from 1 to 10.' }, 400)
      targetElo = skill * 100
      reason = '1-10 rating'
    }
    if ('elo' in patch) {
      const elo = readElo(patch.elo)
      if (elo === null)
        return c.json({ error: 'Elo is a whole number from 100 to 1000.' }, 400)
      targetElo = elo
      reason = 'Advanced elo edit'
    }
    let logAdjustment = false
    if (targetElo !== null) {
      sets.push('elo = ?', 'skill = ?')
      values.push(targetElo, skillFromElo(targetElo))
      // Before any match or adjustment exists the 1-10 control is just the
      // starting point, so move the base rating instead of logging an edit.
      const history = await db
        .prepare(
          'SELECT COUNT(*) AS total FROM rating_results WHERE owner_sub = ? AND player_id = ?',
        )
        .bind(owner, id)
        .first<{ total: number }>()
      logAdjustment = (history?.total ?? 0) > 0
      if (!logAdjustment) {
        sets.push('base_elo = ?')
        values.push(targetElo)
      }
    }
    if ('tags' in patch) {
      const tags = readTags(patch.tags)
      if (!tags)
        return c.json({ error: 'Those roles are not recognised.' }, 400)
      sets.push('tags = ?')
      values.push(JSON.stringify(tags))
    }
    if ('sittingOut' in patch) {
      if (typeof patch.sittingOut !== 'boolean')
        return c.json({ error: 'Sitting out must be true or false.' }, 400)
      sets.push('sitting_out = ?')
      values.push(patch.sittingOut ? 1 : 0)
    }
    if (sets.length === 0) return c.json({ error: 'Nothing to update.' }, 400)
    sets.push('updated_at = ?')
    values.push(Date.now(), id, owner)
    await db
      .prepare(
        `UPDATE players SET ${sets.join(', ')} WHERE id = ? AND owner_sub = ?`,
      )
      .bind(...values)
      .run()

    if (targetElo !== null && logAdjustment && targetElo !== current.elo) {
      const position = await nextPosition(db, owner)
      const now = Date.now()
      await db
        .prepare(
          'INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          crypto.randomUUID(),
          owner,
          position,
          'adjust',
          JSON.stringify({ playerId: id, elo: targetElo, reason }),
          now,
          now,
        )
        .run()
      const players = await recompute(db, owner, position)
      return c.json({ player: players.find((entry) => entry.id === id) ?? null })
    }

    const row = await db
      .prepare(
        'SELECT id, name, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE id = ? AND owner_sub = ?',
      )
      .bind(id, owner)
      .first<PlayerRow>()
    return row
      ? c.json({ player: mapPlayer(row) })
      : c.json({ error: 'Player not found.' }, 404)
  })

  app.delete('/api/players/:id', async (c) => {
    const db = c.get('db')
    const owner = c.get('user').sub
    const id = c.req.param('id')
    const player = await db
      .prepare('SELECT id FROM players WHERE id = ? AND owner_sub = ?')
      .bind(id, owner)
      .first<{ id: string }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)
    const matches = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM rating_results r
         JOIN rating_events e ON e.id = r.event_id AND e.owner_sub = r.owner_sub
         WHERE r.owner_sub = ? AND r.player_id = ? AND e.kind = 'match'`,
      )
      .bind(owner, id)
      .first<{ total: number }>()
    if ((matches?.total ?? 0) > 0)
      return c.json(
        {
          error:
            'This player has match history. Delete or edit those matches before removing them.',
        },
        409,
      )

    // A manual rating is not a match: drop the player's adjustment events with
    // them, or the log would keep ratings for someone no longer on the roster.
    const edits = await db
      .prepare(
        'SELECT DISTINCT event_id FROM rating_results WHERE owner_sub = ? AND player_id = ?',
      )
      .bind(owner, id)
      .all<{ event_id: string }>()
    const eventIds = edits.results.map((row) => row.event_id)
    const statements: Statement[] = []
    if (eventIds.length > 0) {
      const marks = eventIds.map(() => '?').join(', ')
      statements.push(
        db
          .prepare(
            `DELETE FROM rating_results WHERE owner_sub = ? AND event_id IN (${marks})`,
          )
          .bind(owner, ...eventIds),
        db
          .prepare(
            `DELETE FROM rating_events WHERE owner_sub = ? AND id IN (${marks})`,
          )
          .bind(owner, ...eventIds),
      )
    }
    statements.push(
      db
        .prepare('DELETE FROM players WHERE id = ? AND owner_sub = ?')
        .bind(id, owner),
    )
    await db.batch(statements)
    return c.json({ ok: true })
  })

  app.post('/api/players/:id/elo', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'elo' && key !== 'reason'))
      return c.json({ error: 'Nothing to update.' }, 400)
    const elo = readElo(record.elo)
    if (elo === null)
      return c.json({ error: 'Elo is a whole number from 100 to 1000.' }, 400)
    if (
      record.reason !== undefined &&
      (typeof record.reason !== 'string' || record.reason.trim().length > MAX_REASON)
    )
      return c.json({ error: 'That reason is too long.' }, 400)
    const reason =
      typeof record.reason === 'string' && record.reason.trim()
        ? record.reason.trim()
        : 'Manual elo edit'
    const db = c.get('db')
    const owner = c.get('user').sub
    const id = c.req.param('id')
    const player = await db
      .prepare('SELECT id, elo FROM players WHERE id = ? AND owner_sub = ?')
      .bind(id, owner)
      .first<{ id: string; elo: number }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)

    const position = await nextPosition(db, owner)
    const now = Date.now()
    await db
      .prepare(
        'INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        crypto.randomUUID(),
        owner,
        position,
        'adjust',
        JSON.stringify({ playerId: id, elo, reason }),
        now,
        now,
      )
      .run()
    const players = await recompute(db, owner, position)
    return c.json({
      player: players.find((entry) => entry.id === id) ?? null,
      players,
    })
  })

  app.get('/api/matches', async (c) => {
    const db = c.get('db')
    const owner = c.get('user').sub
    return c.json({
      kFactor: await getKFactor(db, owner),
      events: await matchViews(db, owner),
    })
  })

  app.post('/api/matches', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const input = readMatchInput(body)
    if (!input)
      return c.json(
        {
          error:
            'A match needs two teams, damage for every player, a winner and at least one player from your roster.',
        },
        400,
      )
    const db = c.get('db')
    const owner = c.get('user').sub
    const tracked = input.teams.flatMap((team) =>
      team.players.filter((player) => player.tracked).map((player) => player.id),
    )
    if (!(await trackedIdsExist(db, owner, tracked)))
      return c.json({ error: 'Those players are no longer on your roster.' }, 400)
    const count = await db
      .prepare('SELECT COUNT(*) AS total FROM rating_events WHERE owner_sub = ?')
      .bind(owner)
      .first<{ total: number }>()
    if ((count?.total ?? 0) >= MAX_EVENTS)
      return c.json(
        { error: `The log holds ${MAX_EVENTS} events. Delete one to add another.` },
        400,
      )
    const position = await nextPosition(db, owner)
    const id = crypto.randomUUID()
    const now = Date.now()
    await db
      .prepare(
        'INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, owner, position, 'match', JSON.stringify(input), now, now)
      .run()
    const players = await recompute(db, owner, position)
    return c.json({ match: { id, position }, players }, 201)
  })

  app.patch('/api/matches/:id', async (c) => {
    const db = c.get('db')
    const owner = c.get('user').sub
    const id = c.req.param('id')
    const row = await findEvent(db, owner, id)
    if (!row || row.kind !== 'match')
      return c.json({ error: 'Match not found.' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some((key) => key !== 'input' && key !== 'position') ||
      Object.keys(patch).length === 0
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    if (
      'position' in patch &&
      (typeof patch.position !== 'number' || !Number.isInteger(patch.position))
    )
      return c.json({ error: 'That position is not valid.' }, 400)

    let from = row.position
    if ('input' in patch) {
      const input = readMatchInput(patch.input)
      if (!input)
        return c.json(
          {
            error:
              'A match needs two teams, damage for every player, a winner and at least one player from your roster.',
          },
          400,
        )
      const tracked = input.teams.flatMap((team) =>
        team.players.filter((player) => player.tracked).map((player) => player.id),
      )
      if (!(await trackedIdsExist(db, owner, tracked)))
        return c.json({ error: 'Those players are no longer on your roster.' }, 400)
      await db
        .prepare(
          'UPDATE rating_events SET payload = ?, updated_at = ? WHERE id = ? AND owner_sub = ?',
        )
        .bind(JSON.stringify(input), Date.now(), id, owner)
        .run()
    }

    if ('position' in patch) {
      const all = await db
        .prepare(
          'SELECT id FROM rating_events WHERE owner_sub = ? ORDER BY position ASC, created_at ASC, id ASC',
        )
        .bind(owner)
        .all<{ id: string }>()
      const ids = all.results.map((entry) => entry.id)
      const current = ids.indexOf(id)
      const target = Math.max(
        0,
        Math.min(ids.length - 1, Math.trunc(patch.position as number)),
      )
      if (current !== -1 && target !== current) {
        ids.splice(current, 1)
        ids.splice(target, 0, id)
        from = Math.min(from, current, target)
        await db.batch(
          ids.map((eventId, index) =>
            db
              .prepare(
                'UPDATE rating_events SET position = ? WHERE id = ? AND owner_sub = ?',
              )
              .bind(index, eventId, owner),
          ),
        )
      }
    }

    const players = await recompute(db, owner, from)
    return c.json({ ok: true, players })
  })

  app.delete('/api/matches/:id', async (c) => {
    const db = c.get('db')
    const owner = c.get('user').sub
    const id = c.req.param('id')
    const row = await findEvent(db, owner, id)
    if (!row) return c.json({ error: 'Match not found.' }, 404)
    await db.batch([
      db
        .prepare('DELETE FROM rating_results WHERE event_id = ? AND owner_sub = ?')
        .bind(id, owner),
      db
        .prepare('DELETE FROM rating_events WHERE id = ? AND owner_sub = ?')
        .bind(id, owner),
    ])
    const players = await recompute(db, owner, row.position)
    return c.json({ ok: true, players })
  })

  app.get('/api/settings', async (c) =>
    c.json({ kFactor: await getKFactor(c.get('db'), c.get('user').sub) }),
  )

  app.put('/api/settings', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const kFactor = (body as Record<string, unknown>).kFactor
    if (!isKFactor(kFactor))
      return c.json({ error: 'K must be a whole number from 8 to 64.' }, 400)
    const db = c.get('db')
    const owner = c.get('user').sub
    await db
      .prepare(
        'INSERT INTO settings (owner_sub, k_factor, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_sub) DO UPDATE SET k_factor = excluded.k_factor, updated_at = excluded.updated_at',
      )
      .bind(owner, kFactor, Date.now())
      .run()
    // K applies to the whole history: tuning it is the point.
    const players = await recompute(db, owner, 0)
    return c.json({ kFactor, players })
  })

  app.get('/api/rounds', async (c) => {
    const result = await c
      .get('db')
      .prepare(
        'SELECT id, config, created_at FROM rounds WHERE owner_sub = ? ORDER BY created_at DESC, id DESC LIMIT 60',
      )
      .bind(c.get('user').sub)
      .all<RoundRow>()
    return c.json({
      rounds: result.results
        .map((row) => mapRound(row))
        .filter((round): round is NonNullable<typeof round> => round !== null),
    })
  })

  app.post('/api/rounds', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const config =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readRoundConfig((body as Record<string, unknown>).config)
        : null
    if (!config)
      return c.json({ error: "That round's teams could not be saved." }, 400)
    const db = c.get('db')
    const owner = c.get('user').sub
    const round = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      config,
    }
    await db
      .prepare(
        'INSERT INTO rounds (id, owner_sub, config, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(round.id, owner, JSON.stringify(config), round.createdAt)
      .run()
    // Keep the newest rounds only: the list is a memory aid, not an archive.
    await db
      .prepare(
        'DELETE FROM rounds WHERE owner_sub = ? AND id NOT IN (SELECT id FROM rounds WHERE owner_sub = ? ORDER BY created_at DESC, id DESC LIMIT ?)',
      )
      .bind(owner, owner, MAX_ROUNDS)
      .run()
    return c.json({ round }, 201)
  })

  app.delete('/api/rounds/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare('DELETE FROM rounds WHERE id = ? AND owner_sub = ? RETURNING id')
      .bind(c.req.param('id'), c.get('user').sub)
      .first()
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'Round not found.' }, 404)
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS
        ? c.env.ASSETS.fetch(c.req.raw)
        : c.text('Not found', 404),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
