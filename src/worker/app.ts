import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { normalizeTags, ROLE_IDS } from '../shared/roles'
import type { Player, RoundConfig, RoundTeam } from '../shared/types'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import { ensureSchema, mapPlayer, mapRound, type PlayerRow, type RoundRow } from './db'

type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: D1Database }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

const ROSTER_LIMIT = 200
const MAX_BATCH = 50
const MAX_ROUNDS = 100

const readName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 40 ? name : null
}

const readSkill = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10
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

function readTeams(value: unknown): RoundTeam[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null
  const teams: RoundTeam[] = []
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const team = item as Record<string, unknown>
    if (!Array.isArray(team.players) || team.players.length > ROSTER_LIMIT)
      return null
    if (typeof team.sum !== 'number' || !Number.isFinite(team.sum)) return null
    const players: RoundTeam['players'] = []
    for (const raw of team.players) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const player = raw as Record<string, unknown>
      if (typeof player.id !== 'string' || player.id.length > 64) return null
      const name = readName(player.name)
      const skill = readSkill(player.skill)
      const tags = readTags(player.tags)
      if (!name || skill === null || !tags) return null
      players.push({ id: player.id, name, skill, tags })
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
        !['teamCount', 'tolerance', 'spread', 'teams', 'benchedIds'].includes(key),
    )
  )
    return null
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
    tolerance > 100
  )
    return null
  if (
    typeof spread !== 'number' ||
    !Number.isFinite(spread) ||
    spread < 0 ||
    spread > 500
  )
    return null
  const teams = readTeams(config.teams)
  if (!teams || teams.length !== teamCount) return null
  const benchedIds = Array.isArray(config.benchedIds)
    ? config.benchedIds
        .filter((id): id is string => typeof id === 'string' && id.length <= 64)
        .slice(0, ROSTER_LIMIT)
    : []
  return { teamCount, tolerance, spread, teams, benchedIds }
}

/** Tests inject identities; production always uses the Freebuff SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
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
        'SELECT id, name, skill, tags, sitting_out, created_at, updated_at FROM players WHERE owner_sub = ? ORDER BY created_at ASC, id ASC',
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
      tags: draft.tags,
      sittingOut: false,
      createdAt: createdAt + index,
      updatedAt: createdAt + index,
    }))
    await db.batch(
      players.map((player) =>
        db
          .prepare(
            'INSERT INTO players (id, owner_sub, name, skill, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
          )
          .bind(
            player.id,
            owner,
            player.name,
            player.skill,
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
        (key) => !['name', 'skill', 'tags', 'sittingOut'].includes(key),
      )
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    const sets: string[] = []
    const values: unknown[] = []
    if ('name' in patch) {
      const name = readName(patch.name)
      if (!name) return c.json({ error: 'Names are 1 to 40 characters.' }, 400)
      sets.push('name = ?')
      values.push(name)
    }
    if ('skill' in patch) {
      const skill = readSkill(patch.skill)
      if (skill === null)
        return c.json({ error: 'Skills are whole numbers from 1 to 10.' }, 400)
      sets.push('skill = ?')
      values.push(skill)
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
    values.push(Date.now(), c.req.param('id'), c.get('user').sub)
    const row = await c
      .get('db')
      .prepare(
        `UPDATE players SET ${sets.join(', ')} WHERE id = ? AND owner_sub = ? RETURNING id, name, skill, tags, sitting_out, created_at, updated_at`,
      )
      .bind(...values)
      .first<PlayerRow>()
    return row
      ? c.json({ player: mapPlayer(row) })
      : c.json({ error: 'Player not found.' }, 404)
  })

  app.delete('/api/players/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare(
        'DELETE FROM players WHERE id = ? AND owner_sub = ? RETURNING id',
      )
      .bind(c.req.param('id'), c.get('user').sub)
      .first()
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'Player not found.' }, 404)
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
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
