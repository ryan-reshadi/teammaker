import { beforeEach, describe, expect, test } from 'bun:test'
import { databaseFromExecutor, type Executor } from '../src/server/libsql'
import { createBunSqliteDatabase, bunSqliteExecutor } from '../scripts/bun-sqlite'
import { compactLog, createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'
import { ensureSchema, type Database } from '../src/worker/db'

const ORIGIN = 'https://app.example.test'

const makeEnv = (db: Database): Env => ({ DB: db, APP_ORIGIN: ORIGIN })

const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})

const groupByEnv = new WeakMap<Env, Map<string, string>>()

/** Resolves (and creates) the user's group, running the legacy migration first. */
async function groupFor(env: Env, user: string): Promise<string | null> {
  let cache = groupByEnv.get(env)
  if (!cache) {
    cache = new Map()
    groupByEnv.set(env, cache)
  }
  const known = cache.get(user)
  if (known) return known
  const headers = { 'test-user': user, Origin: ORIGIN, 'Content-Type': 'application/json' }
  const listed = await app.request(`${ORIGIN}/api/groups`, { headers }, env)
  if (!listed.ok) return null
  const body = (await listed.json()) as { groups: { id: string }[] }
  if (body.groups[0]) {
    cache.set(user, body.groups[0].id)
    return body.groups[0].id
  }
  const created = await app.request(
    `${ORIGIN}/api/groups`,
    { method: 'POST', headers, body: JSON.stringify({ name: 'Test' }) },
    env,
  )
  if (!created.ok) return null
  const { group } = (await created.json()) as { group: { id: string } }
  cache.set(user, group.id)
  return group.id
}

const groupPath = async (env: Env, user: string, sub: string) => {
  const id = await groupFor(env, user)
  return id ? `/api/groups/${id}${sub}` : sub
}

const DATA_ROUTES = ['/api/players', '/api/matches', '/api/settings', '/api/rounds']

async function call(
  env: Env,
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin: string | null = ORIGIN,
): Promise<Response> {
  let scopedPath = path
  if (user && DATA_ROUTES.some((route) => path === route || path.startsWith(`${route}/`))) {
    const id = await groupFor(env, user)
    if (id) scopedPath = `/api/groups/${id}${path.slice('/api'.length)}`
  }
  return app.request(
    `${ORIGIN}${scopedPath}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}

describe('libSQL adapter', () => {
  let env: Env
  beforeEach(() => {
    env = makeEnv(createBunSqliteDatabase(':memory:'))
  })

  test('creates the schema and adds roles to a database made before they existed', async () => {
    const executor = bunSqliteExecutor(':memory:')
    executor.raw.run(
      `CREATE TABLE players (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, name TEXT NOT NULL,
        skill INTEGER NOT NULL, sitting_out INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    executor.raw.run(
      `INSERT INTO players (id, owner_sub, name, skill, sitting_out, created_at, updated_at)
        VALUES ('old', 'owner', 'Old Timer', 9, 0, 1, 1)`,
    )
    const db = databaseFromExecutor(executor)
    await ensureSchema(db)
    const columns = await db
      .prepare('PRAGMA table_info(players)')
      .all<{ name: string }>()
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(['tags', 'elo', 'base_elo', 'deleted_at']),
    )
    const migrated = await db
      .prepare('SELECT elo, base_elo, tags FROM players WHERE id = ?')
      .bind('old')
      .first<{ elo: number; base_elo: number; tags: string }>()
    expect(migrated).toEqual({ elo: 900, base_elo: 900, tags: '[]' })
    // The guard is idempotent: a second run must not try to add the column again.
    await ensureSchema(db)
  })

  test('players and a group\'s own tags round-trip through the adapter', async () => {
    const tag = async (label: string, short: string) => {
      const response = await call(
        env,
        await groupPath(env, 'alice', '/tags'),
        'alice',
        'POST',
        { label, short },
      )
      expect(response.status).toBe(201)
      return ((await response.json()) as { tag: { id: string } }).tag.id
    }
    const sniper = await tag('Sniper', 'SN')
    const igl = await tag('IGL', 'IG')

    const created = await call(env, '/api/players', 'alice', 'POST', {
      players: [
        { name: 'Ada', skill: 9, tags: [sniper, igl] },
        { name: 'Bo', skill: 4 },
      ],
    })
    expect(created.status).toBe(201)
    const players = ((await created.json()) as {
      players: { id: string; tags: string[]; elo: number }[]
    }).players
    expect(players[0]!.elo).toBe(900)
    expect(players[1]!.elo).toBe(400)
    expect(players[0]!.tags).toEqual([sniper, igl])
    expect(players[1]!.tags).toEqual([])

    const renamed = await call(env, `/api/players/${players[0]!.id}`, 'alice', 'PATCH', {
      name: 'Ada L',
      tags: [sniper],
    })
    expect(renamed.status).toBe(200)
    const patched = (await renamed.json()) as {
      player: { name: string; tags: string[] }
    }
    expect(patched.player).toMatchObject({ name: 'Ada L', tags: [sniper] })

    // Sitting out is device-local now: the group API refuses it.
    expect(
      (
        await call(env, `/api/players/${players[0]!.id}`, 'alice', 'PATCH', {
          sittingOut: true,
        })
      ).status,
    ).toBe(400)

    const removed = await call(env, `/api/players/${players[1]!.id}`, 'alice', 'DELETE')
    expect(removed.status).toBe(200)
    const after = (await (await call(env, '/api/players', 'alice')).json()) as {
      players: unknown[]
    }
    expect(after.players).toHaveLength(1)
  })

  test('keeps accounts apart, refuses strangers and foreign origins', async () => {
    expect((await call(env, '/api/groups/anything/players')).status).toBe(401)
    expect((await call(env, '/api/health')).status).toBe(200)

    await call(env, '/api/players', 'alice', 'POST', { name: 'Ada', skill: 9 })
    const bob = (await (await call(env, '/api/players', 'bob')).json()) as {
      players: unknown[]
    }
    expect(bob.players).toHaveLength(0)

    const foreign = await call(env, '/api/players', 'alice', 'POST', { name: 'X', skill: 5 }, 'https://evil.example')
    expect(foreign.status).toBe(403)
    const missingOrigin = await call(env, '/api/players', 'alice', 'POST', { name: 'X', skill: 5 }, null)
    expect(missingOrigin.status).toBe(403)

    const badTags = await call(env, '/api/players', 'alice', 'POST', {
      name: 'Y',
      skill: 5,
      tags: ['wizard'],
    })
    expect(badTags.status).toBe(400)
  })

  test('reports setup instead of failing when no database is configured', async () => {
    const session = await call({ APP_ORIGIN: ORIGIN }, '/api/session')
    const body = (await session.json()) as { mode: string; database: boolean }
    expect(body).toMatchObject({ mode: 'setup', database: false })
    expect(
      (await call({ APP_ORIGIN: ORIGIN }, '/api/groups/anything/players', 'alice'))
        .status,
    ).toBe(503)
    expect(
      await (await call({ APP_ORIGIN: ORIGIN }, '/api/health')).json(),
    ).toMatchObject({ ok: true, database: 'unconfigured' })
  })

  test('health proves the database answers, then reports the schema it finds', async () => {
    const empty = await call(env, '/api/health')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({
      ok: true,
      database: 'ok',
      schema: 'missing',
    })

    await call(env, '/api/players', 'alice', 'POST', { name: 'Ada', skill: 9 })
    const ready = await call(env, '/api/health')
    expect(await ready.json()).toEqual({
      ok: true,
      database: 'ok',
      schema: 'ready',
    })
  })

  test('health fails loudly when the database cannot be reached', async () => {
    const offline: Database = {
      prepare() {
        throw new Error('connect ECONNREFUSED libsql.example.test')
      },
      async batch() {
        throw new Error('connect ECONNREFUSED libsql.example.test')
      },
    }
    const response = await call({ DB: offline, APP_ORIGIN: ORIGIN }, '/api/health')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, database: 'unreachable' })
  })

  test('the schema bootstrap sends only what the HTTP protocol accepts', async () => {
    // Turso's /v2/pipeline takes one statement per execute, forbids BEGIN and
    // COMMIT inside it, and keeps the transaction around a batch instead.
    const inner = bunSqliteExecutor(':memory:')
    const single = (sql: string) => {
      const body = sql.trim().replace(/;$/, '')
      if (body.includes(';')) throw new Error('multiple statements in one request')
      if (/^(begin|commit|rollback)\b/i.test(body))
        throw new Error('transaction statements are refused')
      return body
    }
    const sent: string[] = []
    const remote: Executor = {
      async execute({ sql, args }) {
        sent.push(single(sql))
        return inner.execute({ sql, args })
      },
      async batch(statements) {
        expect(statements.length).toBeGreaterThan(0)
        statements.forEach((statement) => single(statement.sql))
        await inner.batch(statements)
      },
    }

    const db = databaseFromExecutor(remote)
    await ensureSchema(db)
    const columns = await db
      .prepare("SELECT name FROM pragma_table_info('players')")
      .all<{ name: string }>()
    expect(columns.results.map((column) => column.name)).toContain('tags')
    expect(sent.some((sql) => sql.includes('pragma_table_info'))).toBe(true)
  })

  test('a match replays through the libSQL adapter', async () => {
    const created = await call(env, '/api/players', 'zoe', 'POST', {
      players: [
        { name: 'Ada', skill: 5 },
        { name: 'Bo', skill: 5 },
      ],
    })
    expect(created.status).toBe(201)
    const roster = ((await created.json()) as {
      players: { id: string; name: string; elo: number }[]
    }).players
    const [ada, bo] = roster
    const body = {
      label: 'Duel',
      winner: 0,
      teams: [
        { players: [{ id: ada!.id, name: 'Ada', damage: 100, tracked: true }] },
        { players: [{ id: bo!.id, name: 'Bo', damage: 100, tracked: true }] },
      ],
    }
    const logged = await call(env, '/api/matches', 'zoe', 'POST', body)
    expect(logged.status).toBe(201)
    const eloOf = async (name: string) => {
      const list = ((await (await call(env, '/api/players', 'zoe')).json()) as {
        players: { name: string; elo: number }[]
      }).players
      return list.find((player) => player.name === name)!.elo
    }
    // K is the account setting from the first match: no provisional window.
    expect(await eloOf('Ada')).toBe(516)
    expect(await eloOf('Bo')).toBe(484)

    const log = (await (await call(env, '/api/matches', 'zoe')).json()) as {
      events: { id: string; teams: { players: { delta: number }[] }[] }[]
    }
    expect(log.events[0]!.teams[0]!.players[0]!.delta).toBe(16)

    // Changing K affects future matches only; the stored duel does not move.
    await call(env, '/api/settings', 'zoe', 'PUT', { kFactor: 64 })
    expect(await eloOf('Ada')).toBe(516)
    expect(await eloOf('Bo')).toBe(484)

    const removed = await call(env, `/api/matches/${log.events[0]!.id}`, 'zoe', 'DELETE')
    expect(removed.status).toBe(200)
    expect(await eloOf('Ada')).toBe(500)
    expect(await eloOf('Bo')).toBe(500)
  })

  test('rounds saved before elo are scaled onto the elo axis when read', async () => {
    const executor = bunSqliteExecutor(':memory:')
    const db = databaseFromExecutor(executor)
    await ensureSchema(db)
    executor.raw.run(
      `INSERT INTO rounds (id, owner_sub, config, created_at) VALUES (?, ?, ?, ?)`,
      [
        'legacy',
        'alice',
        JSON.stringify({
          teamCount: 1,
          tolerance: 2,
          spread: 1,
          teams: [
            {
              sum: 9,
              players: [{ id: 'a', name: 'Ada', skill: 9, tags: ['sniper'] }],
            },
          ],
          benchedIds: [],
        }),
        1,
      ],
    )
    const response = await call(makeEnv(db), '/api/rounds', 'alice')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      rounds: {
        config: {
          version: number
          tolerance: number
          spread: number
          teams: { sum: number; players: { elo: number }[] }[]
        }
      }[]
    }
    expect(body.rounds[0]!.config).toMatchObject({
      version: 2,
      tolerance: 200,
      spread: 100,
    })
    expect(body.rounds[0]!.config.teams[0]!.sum).toBe(900)
    expect(body.rounds[0]!.config.teams[0]!.players[0]!.elo).toBe(900)
  })

  test('legacy events stay identical through a K change, an edit and a new v2 match', async () => {
    const executor = bunSqliteExecutor(':memory:')
    const db = databaseFromExecutor(executor)
    await ensureSchema(db)
    const eventId = 'legacy-match'
    const payload = {
      label: 'Legacy',
      winner: 0,
      teams: [
        { players: [{ id: 'a', name: 'Ada', damage: 100, tracked: true }] },
        { players: [{ id: 'b', name: 'Bo', damage: 100, tracked: true }] },
      ],
    }
    for (const [id, name, elo] of [
      ['a', 'Ada', 516],
      ['b', 'Bo', 484],
    ] as const)
      executor.raw.run(
        `INSERT INTO players (id, owner_sub, name, skill, elo, base_elo, tags, sitting_out, created_at, updated_at)
         VALUES (?, 'legacy', ?, 5, ?, 500, '[]', 0, 1, 1)`,
        [id, name, elo],
      )
    executor.raw.run(
      `INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at)
       VALUES (?, 'legacy', 0, 'match', ?, 10, 10)`,
      [eventId, JSON.stringify(payload)],
    )
    executor.raw.run(
      `INSERT INTO rating_results (event_id, owner_sub, slot, player_id, name, elo_before, elo_after, delta)
       VALUES (?, 'legacy', '0:0', 'a', 'Ada', 500, 516, 16), (?, 'legacy', '1:0', 'b', 'Bo', 500, 484, -16)`,
      [eventId, eventId],
    )
    executor.raw.run(
      `INSERT INTO settings (owner_sub, k_factor, updated_at) VALUES ('legacy', 32, 10)`,
    )
    const env = makeEnv(db)
    const players = async () =>
      ((await (await call(env, '/api/players', 'legacy')).json()) as {
        players: { id: string; elo: number; updatedAt: number }[]
      }).players
    const results = async () =>
      (
        await db
          .prepare(
            'SELECT event_id, slot, player_id, elo_before, elo_after, delta FROM rating_results WHERE owner_sub = ? AND event_id = ? ORDER BY slot',
          )
          .bind('legacy', eventId)
          .all()
      ).results

    const startPlayers = await players()
    const startResults = await results()

    // A no-op edit replays the legacy event with the K that produced it.
    const edited = await call(env, `/api/matches/${eventId}`, 'legacy', 'PATCH', {
      input: payload,
    })
    expect(edited.status).toBe(200)
    expect(await players()).toEqual(startPlayers)
    expect(await results()).toEqual(startResults)
    const legacyRow = await db
      .prepare('SELECT payload FROM rating_events WHERE id = ?')
      .bind(eventId)
      .first<{ payload: string }>()
    expect(JSON.parse(legacyRow!.payload)).not.toHaveProperty('formula')

    // Changing K freezes the legacy K and leaves every stored number alone.
    expect((await call(env, '/api/settings', 'legacy', 'PUT', { kFactor: 64 })).status).toBe(
      200,
    )
    expect(await players()).toEqual(startPlayers)
    expect(await results()).toEqual(startResults)
    expect(
      await db
        .prepare('SELECT legacy_k FROM group_rating_meta WHERE group_id = ?')
        .bind(await groupFor(env, 'legacy'))
        .first(),
    ).toEqual({ legacy_k: 32 })

    // A new match is stamped v4 with the new K; the legacy event still reads
    // with its frozen K and its stored results are untouched.
    expect(
      (await call(env, '/api/matches', 'legacy', 'POST', { ...payload, label: 'New' }))
        .status,
    ).toBe(201)
    const newRow = await db
      .prepare(
        'SELECT payload FROM rating_events WHERE owner_sub = ? AND position = 1',
      )
      .bind('legacy')
      .first<{ payload: string }>()
    expect(JSON.parse(newRow!.payload)).toMatchObject({ formula: 4, k: 64 })
    expect(await results()).toEqual(startResults)
  })

  test('a squash folds the anchor into base_elo and drops the oldest events', async () => {
    const db = env.DB!
    const groupId = await groupFor(env, 'squash')
    expect(groupId).not.toBeNull()
    const created = await call(env, '/api/players', 'squash', 'POST', {
      players: [{ name: 'Ada', skill: 5 }],
    })
    const { players } = (await created.json()) as { players: { id: string }[] }
    const id = players[0]!.id

    // Adjustments are absolute, so this log needs no rating maths to be exact.
    for (let position = 0; position < 5; position += 1) {
      await db
        .prepare(
          'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          `evt-${position}`,
          'squash',
          groupId,
          position,
          'adjust',
          JSON.stringify({ playerId: id, elo: 600 + position * 10, reason: 'seed' }),
          position + 1,
          position + 1,
        )
        .run()
      await db
        .prepare(
          'INSERT INTO rating_results (event_id, owner_sub, group_id, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          `evt-${position}`,
          'squash',
          groupId,
          '0',
          id,
          'Ada',
          590 + position * 10,
          600 + position * 10,
          10,
        )
        .run()
    }
    await db.prepare('UPDATE players SET elo = 640 WHERE id = ?').bind(id).run()

    expect(await compactLog(db, groupId!, 2)).toEqual({ removed: 3, kept: 2 })
    expect(
      await db
        .prepare('SELECT elo, base_elo FROM players WHERE id = ?')
        .bind(id)
        .first(),
    ).toEqual({ elo: 640, base_elo: 620 })
    expect(
      await db
        .prepare('SELECT COUNT(*) AS total FROM rating_events WHERE owner_sub = ?')
        .bind('squash')
        .first(),
    ).toEqual({ total: 2 })
    expect(
      await db
        .prepare('SELECT COUNT(*) AS total FROM rating_results WHERE owner_sub = ?')
        .bind('squash')
        .first(),
    ).toEqual({ total: 2 })
    expect(
      ((await (await call(env, '/api/players', 'squash')).json()) as {
        players: { elo: number }[]
      }).players[0]!.elo,
    ).toBe(640)
  })
})
