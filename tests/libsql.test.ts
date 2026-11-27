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
      expect.arrayContaining(['tags', 'elo', 'base_elo']),
    )
    const migrated = await db
      .prepare('SELECT elo, base_elo, tags FROM players WHERE id = ?')
      .bind('old')
      .first<{ elo: number; base_elo: number; tags: string }>()
    expect(migrated).toEqual({ elo: 900, base_elo: 900, tags: '[]' })
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
    const players = ((await created.json()) as {
      players: { id: string; tags: string[]; elo: number }[]
    }).players
    expect(players[0]!.elo).toBe(900)
    expect(players[1]!.elo).toBe(400)
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
        version: 2,
        teamCount: 1,
        tolerance: 300,
        spread: 0,
        benchedIds: [],
        teams: [
          {
            sum: 900,
            players: [{ id: players[0]!.id, name: 'Ada L', elo: 900, tags: ['sniper'] }],
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
        .prepare('SELECT legacy_k FROM rating_meta WHERE owner_sub = ?')
        .bind('legacy')
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
})
