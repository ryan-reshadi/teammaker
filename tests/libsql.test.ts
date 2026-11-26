import { beforeEach, describe, expect, test } from 'bun:test'
import { databaseFromExecutor, type Executor } from '../src/server/libsql'
import { createBunSqliteDatabase, bunSqliteExecutor } from '../scripts/bun-sqlite'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'
import { ensureSchema, type Database } from '../src/worker/db'

const ORIGIN = 'https://app.example.test'

const makeEnv = (db: Database): Env => ({ DB: db, APP_ORIGIN: ORIGIN })

const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})

const call = (
  env: Env,
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin: string | null = ORIGIN,
) =>
  app.request(
    `${ORIGIN}${path}`,
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
    const db = databaseFromExecutor(executor)
    await ensureSchema(db)
    const columns = await db
      .prepare('PRAGMA table_info(players)')
      .all<{ name: string }>()
    expect(columns.results.map((column) => column.name)).toContain('tags')
    // The guard is idempotent: a second run must not try to add the column again.
    await ensureSchema(db)
  })

  test('players, roles and rounds round-trip through the adapter', async () => {
    const created = await call(env, '/api/players', 'alice', 'POST', {
      players: [
        { name: 'Ada', skill: 9, tags: ['sniper', 'igl'] },
        { name: 'Bo', skill: 4 },
      ],
    })
    expect(created.status).toBe(201)
    const players = ((await created.json()) as { players: { id: string; tags: string[] }[] })
      .players
    expect(players[0]!.tags).toEqual(['sniper', 'igl'])
    expect(players[1]!.tags).toEqual([])

    const renamed = await call(env, `/api/players/${players[0]!.id}`, 'alice', 'PATCH', {
      name: 'Ada L',
      sittingOut: true,
      tags: ['sniper'],
    })
    expect(renamed.status).toBe(200)
    const patched = (await renamed.json()) as {
      player: { name: string; sittingOut: boolean; tags: string[] }
    }
    expect(patched.player).toMatchObject({
      name: 'Ada L',
      sittingOut: true,
      tags: ['sniper'],
    })

    const round = await call(env, '/api/rounds', 'alice', 'POST', {
      config: {
        teamCount: 1,
        tolerance: 3,
        spread: 0,
        benchedIds: [],
        teams: [
          {
            sum: 13,
            players: [{ id: players[0]!.id, name: 'Ada L', skill: 9, tags: ['sniper'] }],
          },
        ],
      },
    })
    expect(round.status).toBe(201)

    const listed = await call(env, '/api/rounds', 'alice')
    const rounds = (await listed.json()) as {
      rounds: { config: { teams: { players: { tags: string[] }[] }[] } }[]
    }
    expect(rounds.rounds).toHaveLength(1)
    expect(rounds.rounds[0]!.config.teams[0]!.players[0]!.tags).toEqual(['sniper'])

    const removed = await call(env, `/api/players/${players[1]!.id}`, 'alice', 'DELETE')
    expect(removed.status).toBe(200)
    const after = (await (await call(env, '/api/players', 'alice')).json()) as {
      players: unknown[]
    }
    expect(after.players).toHaveLength(1)
  })

  test('keeps accounts apart, refuses strangers and foreign origins', async () => {
    expect((await call(env, '/api/players')).status).toBe(401)
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
    expect((await call({ APP_ORIGIN: ORIGIN }, '/api/players', 'alice')).status).toBe(503)
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
})
