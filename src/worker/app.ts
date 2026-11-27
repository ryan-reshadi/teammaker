import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  DEFAULT_K_FACTOR,
  FLAT_K_FORMULA,
  MAX_DAMAGE,
  MAX_EVENTS,
  MAX_MATCH_PLAYERS,
  MAX_MATCH_TEAMS,
  clampElo,
  eventFormula,
  isKFactor,
  replay,
  skillFromElo,
  usesProvisionalK,
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
import type { GroupRole, Player } from '../shared/types'
import { appOrigin, currentUser, isLocalPreview } from './auth'
import {
  ensureSchema,
  mapPlayer,
  mapRound,
  REQUIRED_TABLES,
  type Database,
  type PlayerRow,
  type RoundRow,
  type Statement,
} from './db'
import {
  MAX_GROUPS,
  MAX_MEMBERS,
  MAX_TAGS,
  bumpRev,
  countOwnedGroups,
  createGroup,
  ensureGroupForUser,
  hashInviteToken,
  isGroupRole,
  listGroups,
  loadGroupDetail,
  loadTags,
  newInviteToken,
  readGroupName,
  readTagLabel,
  readTagShort,
  roleFor,
  type MemberRow,
} from './groups'
import { groupGuard, sessionGuard, type AppContext, type Authenticate } from './guard'

const ROSTER_LIMIT = 200
const MAX_BATCH = 50
const MAX_LABEL = 60
const MAX_REASON = 80
/** Events a squash removes from the front and keeps at the back. */
export const SQUASH_KEEP = 500
const MATCH_ERROR =
  'A match needs two to eight teams, damage for every player, a winner and at least one player from your roster.'

const readName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 40 ? name : null
}

const MAX_USERNAME = 32

/** An optional handle: empty clears it, absent leaves it as it is. */
const readUsername = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const username = value.trim()
  return username.length <= MAX_USERNAME && !/[\u0000-\u001f\u007f]/.test(username)
    ? username
    : null
}

const readSkill = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10
    ? value
    : null

const readElo = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 1000
    ? value
    : null

/** Absent tags mean none; unknown ids are rejected rather than dropped. */
const readTags = (
  value: unknown,
  allowed: readonly string[],
): string[] | null => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_TAGS) return null
  for (const item of value)
    if (typeof item !== 'string' || !allowed.includes(item)) return null
  return normalizeTags(value, allowed)
}

const readRole = (value: unknown): 'editor' | 'viewer' | null =>
  value === 'editor' || value === 'viewer' ? value : null

type Draft = { name: string; username: string; skill: number; tags: string[] }

function readDrafts(body: unknown, allowedTags: readonly string[]): Draft[] | null {
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
        (key) =>
          key !== 'name' && key !== 'username' && key !== 'skill' && key !== 'tags',
      )
    )
      return null
    const name = readName(entry.name)
    const username =
      entry.username === undefined ? '' : readUsername(entry.username)
    const skill = readSkill(entry.skill)
    const tags = readTags(entry.tags, allowedTags)
    if (!name || username === null || skill === null || !tags) return null
    drafts.push({ name, username, skill, tags })
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
  if (
    !Array.isArray(record.teams) ||
    record.teams.length < 2 ||
    record.teams.length > MAX_MATCH_TEAMS
  )
    return null

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
  if (
    typeof record.winner !== 'number' ||
    !Number.isInteger(record.winner) ||
    record.winner < 0 ||
    record.winner >= teams.length
  )
    return null
  return { label, teams, winner: record.winner }
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

async function loadEvents(db: Database, groupId: string): Promise<RatingEvent[]> {
  const rows = await db
    .prepare(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC',
    )
    .bind(groupId)
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

async function getKFactor(db: Database, groupId: string): Promise<number> {
  const row = await db
    .prepare('SELECT k_factor FROM groups WHERE id = ? AND deleted_at IS NULL')
    .bind(groupId)
    .first<{ k_factor: number }>()
  return row && isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR
}

/**
 * The K that produced ratings written before versioning. Until a K change or
 * the first v2 match pins it, the group's current setting is still that K.
 */
async function getLegacyK(
  db: Database,
  groupId: string,
  currentK: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT legacy_k FROM group_rating_meta WHERE group_id = ?')
    .bind(groupId)
    .first<{ legacy_k: number }>()
  return row && isKFactor(row.legacy_k) ? row.legacy_k : currentK
}

/** One additive row; it never rewrites an existing event or result. */
async function pinLegacyK(
  db: Database,
  groupId: string,
  legacyK: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO group_rating_meta (group_id, legacy_k, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO NOTHING',
    )
    .bind(groupId, legacyK, Date.now())
    .run()
}

async function loadPlayers(
  db: Database,
  groupId: string,
  allowedTags: readonly string[],
): Promise<Player[]> {
  const result = await db
    .prepare(
      'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<PlayerRow>()
  return result.results.map((row) => mapPlayer(row, allowedTags))
}

async function nextPosition(db: Database, groupId: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM rating_events WHERE group_id = ?',
    )
    .bind(groupId)
    .first<{ next: number }>()
  return row?.next ?? 0
}

async function findEvent(
  db: Database,
  groupId: string,
  id: string,
): Promise<EventRow | null> {
  return db
    .prepare(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE id = ? AND group_id = ?',
    )
    .bind(id, groupId)
    .first<EventRow>()
}

const insertResultSql =
  'INSERT INTO rating_results (event_id, owner_sub, group_id, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

/**
 * Rebuilds every rating from the log, then writes the affected bookkeeping
 * rows. `from` is the earliest position whose outcome can have changed.
 */
async function recompute(
  db: Database,
  groupId: string,
  from: number,
): Promise<Player[]> {
  const players = await db
    .prepare(
      'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo, deleted_at FROM players WHERE group_id = ? ORDER BY created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<BaseRow>()
  const events = await loadEvents(db, groupId)
  const kFactor = await getKFactor(db, groupId)
  const legacyK = await getLegacyK(db, groupId, kFactor)
  // `owner_sub` stays the group's creator for older readers and the existing
  // test queries; every route scopes by `group_id`.
  const owner = await db
    .prepare('SELECT owner_sub FROM groups WHERE id = ?')
    .bind(groupId)
    .first<{ owner_sub: string }>()
  const ownerSub = owner?.owner_sub ?? groupId
  const roster: MatchRoster[] = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo,
  }))
  const { elos, outcomes }: ReplayResult = replay(events, roster, kFactor, legacyK)

  const statements: Statement[] = []
  for (const player of players.results) {
    const elo = elos.get(player.id) ?? player.elo
    const skill = skillFromElo(elo)
    if (elo !== player.elo || skill !== player.skill)
      statements.push(
        db
          .prepare('UPDATE players SET elo = ?, skill = ? WHERE id = ? AND group_id = ?')
          .bind(elo, skill, player.id, groupId),
      )
  }

  statements.push(
    db
      .prepare(
        'DELETE FROM rating_results WHERE group_id = ? AND event_id IN (SELECT id FROM rating_events WHERE group_id = ? AND position >= ?)',
      )
      .bind(groupId, groupId, from),
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
                ownerSub,
                groupId,
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
          ownerSub,
          groupId,
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

  const tags = await loadTags(db, groupId)
  const allowed = tags.map((tag) => tag.id)
  return players.results
    .filter((player) => !player.deleted_at)
    .map((player) =>
      mapPlayer(
        {
          ...player,
          elo: elos.get(player.id) ?? player.elo,
          skill: skillFromElo(elos.get(player.id) ?? player.elo),
        },
        allowed,
      ),
    )
}

async function countEvents(db: Database, groupId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM rating_events WHERE group_id = ?')
    .bind(groupId)
    .first<{ total: number }>()
  return row?.total ?? 0
}

/**
 * Folds the oldest events into each player's replay anchor, then deletes them.
 * `base_elo` becomes the elo at the cut, so the kept log replays forward to
 * exactly the ratings it produced before: no `elo` moves and every kept
 * `rating_results` row stays valid. Only the history is lost.
 */
export async function compactLog(
  db: Database,
  groupId: string,
  keep = SQUASH_KEEP,
): Promise<{ removed: number; kept: number }> {
  const events = await loadEvents(db, groupId)
  if (events.length <= keep) return { removed: 0, kept: events.length }

  let cut = events.length - keep
  for (let index = events.length - 1; index >= cut; index -= 1) {
    const event = events[index]!
    if (event.kind === 'match' && usesProvisionalK(eventFormula(event.payload))) {
      cut = index + 1
      break
    }
  }
  if (cut >= events.length) return { removed: 0, kept: events.length }

  const players = await db
    .prepare(
      'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo, deleted_at FROM players WHERE group_id = ? ORDER BY created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<BaseRow>()
  const kFactor = await getKFactor(db, groupId)
  const legacyK = await getLegacyK(db, groupId, kFactor)
  const roster: MatchRoster[] = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo,
  }))
  const { elos } = replay(events.slice(0, cut), roster, kFactor, legacyK)

  const oldest = `(SELECT id FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC LIMIT ${cut})`
  const statements: Statement[] = []
  for (const player of players.results) {
    const anchor = clampElo(elos.get(player.id) ?? player.base_elo)
    if (anchor === player.base_elo) continue
    statements.push(
      db
        .prepare('UPDATE players SET base_elo = ? WHERE id = ? AND group_id = ?')
        .bind(anchor, player.id, groupId),
    )
  }
  statements.push(
    db
      .prepare(`DELETE FROM rating_results WHERE group_id = ? AND event_id IN ${oldest}`)
      .bind(groupId, groupId),
    db.prepare(`DELETE FROM rating_events WHERE id IN ${oldest}`).bind(groupId),
    db
      .prepare(
        'INSERT INTO group_squashes (group_id, removed, squashed_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET removed = group_squashes.removed + excluded.removed, squashed_at = excluded.squashed_at',
      )
      .bind(groupId, cut, Date.now()),
    bumpRev(db, groupId),
  )
  await db.batch(statements)
  return { removed: cut, kept: events.length - cut }
}

/**
 * Makes room for one more event, compacting a full log. `false` means the log is
 * at the cap and nothing could safely be cut.
 */
async function makeRoom(db: Database, groupId: string): Promise<boolean> {
  if ((await countEvents(db, groupId)) < MAX_EVENTS) return true
  const { removed } = await compactLog(db, groupId)
  return removed > 0
}

async function matchViews(
  db: Database,
  groupId: string,
): Promise<RatingEventView[]> {
  const events = await loadEvents(db, groupId)
  const rows = await db
    .prepare(
      'SELECT event_id, slot, player_id, name, elo_before, elo_after, delta FROM rating_results WHERE group_id = ?',
    )
    .bind(groupId)
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

/**
 * New matches may only name players on the group's roster. An edit passes
 * `includeArchived`, because a lineup logged before a removal must stay
 * editable and the archived row still has a real rating in the replay.
 */
async function trackedIdsExist(
  db: Database,
  groupId: string,
  ids: string[],
  includeArchived = false,
): Promise<boolean> {
  if (ids.length === 0) return true
  const rows = await db
    .prepare(
      `SELECT id FROM players WHERE group_id = ?${includeArchived ? '' : ' AND deleted_at IS NULL'} AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(groupId, ...ids)
    .all<{ id: string }>()
  return rows.results.length === new Set(ids).size
}

/** Tests inject identities; production uses the SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()

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

  // Reachability probe: one real round trip, no authentication, no rows written.
  app.get('/api/health', async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const db = c.env.DB
    if (!db) return c.json({ ok: true, database: 'unconfigured' })
    try {
      await db.prepare('SELECT 1 AS ok').first<{ ok: number }>()
      const tables = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(
            (table) => `'${table}'`,
          ).join(', ')})`,
        )
        .all<{ name: string }>()
      return c.json({
        ok: true,
        database: 'ok',
        schema: tables.results.length === REQUIRED_TABLES.length ? 'ready' : 'missing',
      })
    } catch (error) {
      console.error(
        'Teammaker: database health check failed',
        error instanceof Error ? error.message : error,
      )
      return c.json({ ok: false, database: 'unreachable' }, 503)
    }
  })

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

  const guard = groupGuard(authenticate)

  // A token holder may see which group and role a link is for before signing
  // in: the 32-byte token is the credential. Accepting still needs an account.
  app.get('/api/invites/:token', async (c) => {
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    const invite = await loadInvite(c.env.DB, c.req.param('token'))
    return invite
      ? c.json({ invite })
      : c.json({ error: 'That invite link is no longer valid.' }, 404)
  })

  // The group list and accepting an invite are account-level routes; everything
  // inside a group goes through `guard`, which decides read/editor/owner.
  app.use('/api/groups', sessionGuard(authenticate))
  app.use('/api/invites/:token/accept', sessionGuard(authenticate))
  app.use('/api/groups/:groupId', guard)
  app.use('/api/groups/:groupId/*', guard)

  app.get('/api/groups', async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    await ensureGroupForUser(db, { sub: user.sub, name: user.name })
    if (user.name)
      await db
        .prepare(
          'UPDATE group_members SET display_name = ?, updated_at = ? WHERE user_sub = ? AND display_name <> ?',
        )
        .bind(user.name, Date.now(), user.sub, user.name)
        .run()
    return c.json({ groups: await listGroups(db, user.sub) })
  })

  app.post('/api/groups', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const name =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readGroupName((body as Record<string, unknown>).name)
        : null
    if (!name) return c.json({ error: 'Group names are 1 to 40 characters.' }, 400)
    const db = c.get('db')
    const user = c.get('user')
    if ((await countOwnedGroups(db, user.sub)) >= MAX_GROUPS)
      return c.json({ error: `You can own up to ${MAX_GROUPS} groups.` }, 400)
    return c.json(
      { group: await createGroup(db, { sub: user.sub, name: user.name }, name) },
      201,
    )
  })

  app.get('/api/groups/:groupId', async (c) => {
    const detail = await loadGroupDetail(
      c.get('db'),
      c.get('groupId'),
      c.get('user').sub,
    )
    return detail ? c.json({ group: detail }) : c.json({ error: 'Group not found.' }, 404)
  })

  app.patch('/api/groups/:groupId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some((key) => key !== 'name' && key !== 'kFactor') ||
      Object.keys(patch).length === 0
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    const sets: string[] = []
    const values: unknown[] = []
    if ('name' in patch) {
      const name = readGroupName(patch.name)
      if (!name) return c.json({ error: 'Group names are 1 to 40 characters.' }, 400)
      sets.push('name = ?')
      values.push(name)
    }
    if ('kFactor' in patch) {
      if (!isKFactor(patch.kFactor))
        return c.json({ error: 'K must be a whole number from 8 to 64.' }, 400)
      sets.push('k_factor = ?')
      values.push(patch.kFactor)
    }
    const db = c.get('db')
    const groupId = c.get('groupId')
    sets.push('updated_at = ?', 'rev = rev + 1')
    values.push(Date.now(), groupId)
    await db
      .prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run()
    const detail = await loadGroupDetail(db, groupId, c.get('user').sub)
    return detail ? c.json({ group: detail }) : c.json({ error: 'Group not found.' }, 404)
  })

  app.delete('/api/groups/:groupId', async (c) => {
    const now = Date.now()
    await c
      .get('db')
      .prepare(
        'UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      )
      .bind(now, now, c.get('groupId'))
      .run()
    return c.json({ ok: true })
  })

  app.get('/api/groups/:groupId/rev', async (c) => {
    const row = await c
      .get('db')
      .prepare('SELECT rev FROM groups WHERE id = ? AND deleted_at IS NULL')
      .bind(c.get('groupId'))
      .first<{ rev: number }>()
    return row ? c.json({ rev: row.rev }) : c.json({ error: 'Group not found.' }, 404)
  })

  // ---- tags ---------------------------------------------------------------

  app.post('/api/groups/:groupId/tags', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'A tag needs a label.' }, 400)
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'label' && key !== 'short'))
      return c.json({ error: 'A tag needs a label.' }, 400)
    const label = readTagLabel(record.label)
    const short = readTagShort(record.short)
    if (!label || short === null)
      return c.json({ error: 'Labels are 1 to 24 characters, short forms up to 3.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tags = await loadTags(db, groupId)
    if (tags.length >= MAX_TAGS)
      return c.json({ error: `A group holds up to ${MAX_TAGS} tags.` }, 400)
    const id = crypto.randomUUID()
    const sort = tags.length
    const now = Date.now()
    await db.batch([
      db
        .prepare(
          'INSERT INTO group_tags (group_id, id, label, short, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(groupId, id, label, short, sort, now, now),
      bumpRev(db, groupId, now),
    ])
    return c.json({ tag: { id, label, short, sort } }, 201)
  })

  app.patch('/api/groups/:groupId/tags/:tagId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some(
        (key) => key !== 'label' && key !== 'short' && key !== 'sort',
      ) ||
      Object.keys(patch).length === 0
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tagId = c.req.param('tagId')
    const current = await db
      .prepare('SELECT id FROM group_tags WHERE group_id = ? AND id = ?')
      .bind(groupId, tagId)
      .first<{ id: string }>()
    if (!current) return c.json({ error: 'Tag not found.' }, 404)
    const sets: string[] = []
    const values: unknown[] = []
    if ('label' in patch) {
      const label = readTagLabel(patch.label)
      if (!label) return c.json({ error: 'Labels are 1 to 24 characters.' }, 400)
      sets.push('label = ?')
      values.push(label)
    }
    if ('short' in patch) {
      const short = readTagShort(patch.short)
      if (short === null)
        return c.json({ error: 'Short forms are up to 3 characters.' }, 400)
      sets.push('short = ?')
      values.push(short)
    }
    if ('sort' in patch) {
      if (
        typeof patch.sort !== 'number' ||
        !Number.isInteger(patch.sort) ||
        patch.sort < 0 ||
        patch.sort > MAX_TAGS
      )
        return c.json({ error: 'That order is not valid.' }, 400)
      sets.push('sort = ?')
      values.push(patch.sort)
    }
    sets.push('updated_at = ?')
    values.push(Date.now(), groupId, tagId)
    await db.batch([
      db
        .prepare(
          `UPDATE group_tags SET ${sets.join(', ')} WHERE group_id = ? AND id = ?`,
        )
        .bind(...values),
      bumpRev(db, groupId),
    ])
    return c.json({ ok: true })
  })

  app.delete('/api/groups/:groupId/tags/:tagId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tagId = c.req.param('tagId')
    const current = await db
      .prepare('SELECT id FROM group_tags WHERE group_id = ? AND id = ?')
      .bind(groupId, tagId)
      .first<{ id: string }>()
    if (!current) return c.json({ error: 'Tag not found.' }, 404)
    const tags = await loadTags(db, groupId)
    const remaining = tags.filter((tag) => tag.id !== tagId).map((tag) => tag.id)
    const players = await db
      .prepare('SELECT id, tags FROM players WHERE group_id = ?')
      .bind(groupId)
      .all<{ id: string; tags: string }>()
    const statements: Statement[] = []
    for (const player of players.results) {
      let parsed: unknown
      try {
        parsed = JSON.parse(player.tags)
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || !parsed.includes(tagId)) continue
      statements.push(
        db
          .prepare('UPDATE players SET tags = ?, updated_at = ? WHERE id = ? AND group_id = ?')
          .bind(JSON.stringify(normalizeTags(parsed, remaining)), Date.now(), player.id, groupId),
      )
    }
    statements.push(
      db
        .prepare('DELETE FROM group_tags WHERE group_id = ? AND id = ?')
        .bind(groupId, tagId),
      bumpRev(db, groupId),
    )
    await db.batch(statements)
    return c.json({ ok: true, tags: remaining })
  })

  // ---- sharing ------------------------------------------------------------

  app.post('/api/groups/:groupId/invites', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const role =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readRole((body as Record<string, unknown>).role)
        : null
    if (!role)
      return c.json({ error: 'Pick editor or viewer for the invite.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const token = newInviteToken()
    const id = crypto.randomUUID()
    const now = Date.now()
    await db
      .prepare(
        'INSERT INTO group_invites (id, group_id, role, token_hash, created_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, groupId, role, await hashInviteToken(token), c.get('user').sub, now)
      .run()
    const origin = appOrigin(c.req.raw, c.env) ?? new URL(c.req.url).origin
    return c.json(
      { invite: { id, role, createdAt: now, url: `${origin}/join/${token}` } },
      201,
    )
  })

  app.get('/api/groups/:groupId/invites', async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        'SELECT id, role, created_at FROM group_invites WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
      .bind(c.get('groupId'))
      .all<{ id: string; role: string; created_at: number }>()
    return c.json({
      invites: rows.results.map((row) => ({
        id: row.id,
        role: row.role === 'editor' ? 'editor' : 'viewer',
        createdAt: row.created_at,
      })),
    })
  })

  app.delete('/api/groups/:groupId/invites/:inviteId', async (c) => {
    const row = await c
      .get('db')
      .prepare(
        'UPDATE group_invites SET revoked_at = ? WHERE id = ? AND group_id = ? AND revoked_at IS NULL RETURNING id',
      )
      .bind(Date.now(), c.req.param('inviteId'), c.get('groupId'))
      .first()
    return row ? c.json({ ok: true }) : c.json({ error: 'Invite not found.' }, 404)
  })

  app.get('/api/groups/:groupId/members', async (c) => {
    const detail = await loadGroupDetail(
      c.get('db'),
      c.get('groupId'),
      c.get('user').sub,
    )
    return detail ? c.json({ members: detail.members }) : c.json({ error: 'Group not found.' }, 404)
  })

  app.patch('/api/groups/:groupId/members/:userId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const role =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readRole((body as Record<string, unknown>).role)
        : null
    if (!role) return c.json({ error: 'Pick editor or viewer.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const userId = c.req.param('userId')
    const owner = await db
      .prepare('SELECT owner_sub FROM groups WHERE id = ?')
      .bind(groupId)
      .first<{ owner_sub: string }>()
    if (owner?.owner_sub === userId)
      return c.json({ error: 'The owner keeps their role.' }, 400)
    const changed = await db
      .prepare(
        'UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND user_sub = ? RETURNING user_sub',
      )
      .bind(role, Date.now(), groupId, userId)
      .first()
    if (!changed) return c.json({ error: 'Member not found.' }, 404)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true })
  })

  app.delete('/api/groups/:groupId/members/:userId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const userId = c.req.param('userId')
    const owner = await db
      .prepare('SELECT owner_sub FROM groups WHERE id = ?')
      .bind(groupId)
      .first<{ owner_sub: string }>()
    if (owner?.owner_sub === userId)
      return c.json({ error: 'The owner cannot be removed.' }, 400)
    const removed = await db
      .prepare(
        'DELETE FROM group_members WHERE group_id = ? AND user_sub = ? RETURNING user_sub',
      )
      .bind(groupId, userId)
      .first()
    if (!removed) return c.json({ error: 'Member not found.' }, 404)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true })
  })

  app.post('/api/invites/:token/accept', async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const invite = await loadInvite(db, c.req.param('token'))
    if (!invite) return c.json({ error: 'That invite link is no longer valid.' }, 404)
    const now = Date.now()
    const owner = await db
      .prepare('SELECT owner_sub FROM groups WHERE id = ?')
      .bind(invite.groupId)
      .first<{ owner_sub: string }>()
    if (owner?.owner_sub !== user.sub) {
      const members = await db
        .prepare('SELECT COUNT(*) AS total FROM group_members WHERE group_id = ?')
        .bind(invite.groupId)
        .first<{ total: number }>()
      if ((members?.total ?? 0) + 1 > MAX_MEMBERS)
        return c.json({ error: 'That group is full.' }, 400)
      await db
        .prepare(
          `INSERT INTO group_members (group_id, user_sub, role, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(group_id, user_sub) DO NOTHING`,
        )
        .bind(invite.groupId, user.sub, invite.role, user.name ?? '', now, now)
        .run()
    }
    await bumpRev(db, invite.groupId).run()
    return c.json({ group: { id: invite.groupId, name: invite.name, role: invite.role } })
  })

  // ---- players ------------------------------------------------------------

  app.get('/api/groups/:groupId/players', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tags = (await loadTags(db, groupId)).map((tag) => tag.id)
    return c.json({ players: await loadPlayers(db, groupId, tags) })
  })

  app.post('/api/groups/:groupId/players', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const allowed = (await loadTags(db, groupId)).map((tag) => tag.id)
    const body: unknown = await c.req.json().catch(() => null)
    const drafts = readDrafts(body, allowed)
    if (!drafts)
      return c.json(
        { error: 'Each player needs a name, a skill from 1 to 10 and known tags.' },
        400,
      )
    const existing = await db
      .prepare(
        'SELECT COUNT(*) AS total FROM players WHERE group_id = ? AND deleted_at IS NULL',
      )
      .bind(groupId)
      .first<{ total: number }>()
    if ((existing?.total ?? 0) + drafts.length > ROSTER_LIMIT)
      return c.json({ error: 'A roster holds up to 200 players.' }, 400)
    const createdAt = Date.now()
    const players: Player[] = drafts.map((draft, index) => ({
      id: crypto.randomUUID(),
      name: draft.name,
      username: draft.username,
      skill: draft.skill,
      elo: clampElo(draft.skill * 100),
      tags: draft.tags,
      createdAt: createdAt + index,
      updatedAt: createdAt + index,
    }))
    await db.batch([
      ...players.map((player) =>
        db
          .prepare(
            'INSERT INTO players (id, owner_sub, group_id, name, username, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
          )
          .bind(
            player.id,
            c.get('user').sub,
            groupId,
            player.name,
            player.username ?? '',
            player.skill,
            player.elo,
            player.elo,
            JSON.stringify(player.tags),
            player.createdAt,
            player.updatedAt,
          ),
      ),
      bumpRev(db, groupId),
    ])
    return c.json({ players }, 201)
  })

  app.patch('/api/groups/:groupId/players/:playerId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some(
        (key) => !['name', 'username', 'skill', 'elo', 'tags'].includes(key),
      )
    )
      return c.json(
        {
          error:
            'Nothing to update. Sitting out is saved on each device, not in the group.',
        },
        400,
      )
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('playerId')
    const current = await db
      .prepare(
        'SELECT id, elo FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<{ id: string; elo: number }>()
    if (!current) return c.json({ error: 'Player not found.' }, 404)
    const allowed = (await loadTags(db, groupId)).map((tag) => tag.id)

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
    if ('username' in patch) {
      const username = readUsername(patch.username)
      if (username === null)
        return c.json({ error: 'Usernames are up to 32 characters.' }, 400)
      sets.push('username = ?')
      values.push(username)
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
      const history = await db
        .prepare(
          'SELECT COUNT(*) AS total FROM rating_results WHERE group_id = ? AND player_id = ?',
        )
        .bind(groupId, id)
        .first<{ total: number }>()
      logAdjustment = (history?.total ?? 0) > 0
      if (!logAdjustment) {
        sets.push('base_elo = ?')
        values.push(targetElo)
      }
    }
    if ('tags' in patch) {
      const tags = readTags(patch.tags, allowed)
      if (!tags) return c.json({ error: 'Those tags are not in this group.' }, 400)
      sets.push('tags = ?')
      values.push(JSON.stringify(tags))
    }
    if (sets.length === 0) return c.json({ error: 'Nothing to update.' }, 400)
    sets.push('updated_at = ?')
    values.push(Date.now(), id, groupId)
    await db.batch([
      db
        .prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`)
        .bind(...values),
      bumpRev(db, groupId),
    ])

    if (targetElo !== null && logAdjustment && targetElo !== current.elo) {
      await makeRoom(db, groupId)
      const position = await nextPosition(db, groupId)
      const now = Date.now()
      await db
        .prepare(
          'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          crypto.randomUUID(),
          c.get('user').sub,
          groupId,
          position,
          'adjust',
          JSON.stringify({ playerId: id, elo: targetElo, reason }),
          now,
          now,
        )
        .run()
      const players = await recompute(db, groupId, position)
      return c.json({ player: players.find((entry) => entry.id === id) ?? null })
    }

    const row = await db
      .prepare(
        'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<PlayerRow>()
    return row
      ? c.json({ player: mapPlayer(row, allowed) })
      : c.json({ error: 'Player not found.' }, 404)
  })

  app.delete('/api/groups/:groupId/players/:playerId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('playerId')
    const player = await db
      .prepare(
        'SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<{ id: string }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)
    // Archive, do not erase: the row keeps its creation elo, so every replay
    // seeds this player exactly as before and nobody else's rating moves.
    const now = Date.now()
    await db.batch([
      db
        .prepare(
          'UPDATE players SET deleted_at = ?, updated_at = ? WHERE id = ? AND group_id = ?',
        )
        .bind(now, now, id, groupId),
      bumpRev(db, groupId, now),
    ])
    return c.json({ ok: true })
  })

  app.post('/api/groups/:groupId/players/:playerId/elo', async (c) => {
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
    const groupId = c.get('groupId')
    const id = c.req.param('playerId')
    const player = await db
      .prepare(
        'SELECT id, elo FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<{ id: string; elo: number }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)

    await makeRoom(db, groupId)
    const position = await nextPosition(db, groupId)
    const now = Date.now()
    await db
      .prepare(
        'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        crypto.randomUUID(),
        c.get('user').sub,
        groupId,
        position,
        'adjust',
        JSON.stringify({ playerId: id, elo, reason }),
        now,
        now,
      )
      .run()
    const players = await recompute(db, groupId, position)
    await bumpRev(db, groupId).run()
    return c.json({
      player: players.find((entry) => entry.id === id) ?? null,
      players,
    })
  })

  // ---- matches ------------------------------------------------------------

  app.get('/api/groups/:groupId/matches', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const squash = await db
      .prepare('SELECT removed, squashed_at FROM group_squashes WHERE group_id = ?')
      .bind(groupId)
      .first<{ removed: number; squashed_at: number }>()
    return c.json({
      kFactor: await getKFactor(db, groupId),
      squashed: squash
        ? { removed: squash.removed, at: squash.squashed_at }
        : null,
      events: await matchViews(db, groupId),
    })
  })

  app.post('/api/groups/:groupId/matches', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const input = readMatchInput(body)
    if (!input) return c.json({ error: MATCH_ERROR }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tracked = input.teams.flatMap((team) =>
      team.players.filter((player) => player.tracked).map((player) => player.id),
    )
    if (!(await trackedIdsExist(db, groupId, tracked)))
      return c.json({ error: "Those players are no longer on this group's roster." }, 400)
    if (!(await makeRoom(db, groupId)))
      return c.json(
        { error: `The log holds ${MAX_EVENTS} events. Delete one to add another.` },
        400,
      )
    const position = await nextPosition(db, groupId)
    const id = crypto.randomUUID()
    const now = Date.now()
    const kFactor = await getKFactor(db, groupId)
    await pinLegacyK(db, groupId, kFactor)
    const payload: MatchInput = {
      ...input,
      formula: FLAT_K_FORMULA,
      k: kFactor,
    }
    await db
      .prepare(
        'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        c.get('user').sub,
        groupId,
        position,
        'match',
        JSON.stringify(payload),
        now,
        now,
      )
      .run()
    const players = await recompute(db, groupId, position)
    await bumpRev(db, groupId).run()
    return c.json({ match: { id, position }, players }, 201)
  })

  app.patch('/api/groups/:groupId/matches/:matchId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('matchId')
    const row = await findEvent(db, groupId, id)
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
      if (!input) return c.json({ error: MATCH_ERROR }, 400)
      const tracked = input.teams.flatMap((team) =>
        team.players.filter((player) => player.tracked).map((player) => player.id),
      )
      if (!(await trackedIdsExist(db, groupId, tracked, true)))
        return c.json({ error: "Those players are no longer on this group's roster." }, 400)
      let marker: { formula?: 2 | 3 | 4; k?: number } = {}
      try {
        const existing = JSON.parse(row.payload) as MatchInput
        const version = eventFormula(existing)
        if (version !== 1) {
          marker = { formula: version }
          if (isKFactor(existing.k)) marker.k = existing.k
        }
      } catch {
        // A malformed legacy payload is left unmarked, as it was.
      }
      const nextInput: MatchInput = { ...input, ...marker }
      await db
        .prepare(
          'UPDATE rating_events SET payload = ?, updated_at = ? WHERE id = ? AND group_id = ?',
        )
        .bind(JSON.stringify(nextInput), Date.now(), id, groupId)
        .run()
    }

    if ('position' in patch) {
      const all = await db
        .prepare(
          'SELECT id FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC',
        )
        .bind(groupId)
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
                'UPDATE rating_events SET position = ? WHERE id = ? AND group_id = ?',
              )
              .bind(index, eventId, groupId),
          ),
        )
      }
    }

    const players = await recompute(db, groupId, from)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true, players })
  })

  app.delete('/api/groups/:groupId/matches/:matchId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('matchId')
    const row = await findEvent(db, groupId, id)
    if (!row) return c.json({ error: 'Match not found.' }, 404)
    await db.batch([
      db
        .prepare('DELETE FROM rating_results WHERE event_id = ? AND group_id = ?')
        .bind(id, groupId),
      db
        .prepare('DELETE FROM rating_events WHERE id = ? AND group_id = ?')
        .bind(id, groupId),
    ])
    const players = await recompute(db, groupId, row.position)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true, players })
  })

  // ---- settings -----------------------------------------------------------

  app.get('/api/groups/:groupId/settings', async (c) =>
    c.json({ kFactor: await getKFactor(c.get('db'), c.get('groupId')) }),
  )

  app.put('/api/groups/:groupId/settings', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const kFactor = (body as Record<string, unknown>).kFactor
    if (!isKFactor(kFactor))
      return c.json({ error: 'K must be a whole number from 8 to 64.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    await pinLegacyK(db, groupId, await getKFactor(db, groupId))
    await db.batch([
      db
        .prepare('UPDATE groups SET k_factor = ?, updated_at = ? WHERE id = ?')
        .bind(kFactor, Date.now(), groupId),
      bumpRev(db, groupId),
    ])
    const tags = (await loadTags(db, groupId)).map((tag) => tag.id)
    return c.json({
      kFactor,
      players: await loadPlayers(db, groupId, tags),
    })
  })

  // ---- legacy saved rounds ------------------------------------------------

  /**
   * Saved rounds are per-device now. This read-only route exists so the owner
   * can import the snapshots that used to live in the account; nothing writes
   * rounds on the server any more.
   */
  app.get('/api/groups/:groupId/rounds', async (c) => {
    const result = await c
      .get('db')
      .prepare(
        'SELECT id, config, created_at FROM rounds WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 60',
      )
      .bind(c.get('groupId'))
      .all<RoundRow>()
    return c.json({
      rounds: result.results
        .map((row) => mapRound(row))
        .filter((round): round is NonNullable<typeof round> => round !== null),
    })
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

type InviteRow = { group_id: string; role: string; name: string }

/** Looks up a live invite by the hash of its token. */
async function loadInvite(
  db: Database,
  token: string,
): Promise<{ groupId: string; name: string; role: 'editor' | 'viewer' } | null> {
  if (!token || token.length > 128) return null
  const row = await db
    .prepare(
      `SELECT i.group_id, i.role, g.name FROM group_invites i
       JOIN groups g ON g.id = i.group_id
       WHERE i.token_hash = ? AND i.revoked_at IS NULL AND g.deleted_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at > ?)`,
    )
    .bind(await hashInviteToken(token), Date.now())
    .first<InviteRow>()
  if (!row) return null
  return {
    groupId: row.group_id,
    name: row.name,
    role: row.role === 'editor' ? 'editor' : 'viewer',
  }
}

export type { MemberRow, GroupRole }
