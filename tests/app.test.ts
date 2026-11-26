import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-db',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: { DB: { type: 'd1', name: 'teammaker-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env
beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

// This identity seam exists only in the app factory. The Worker entrypoint
// never reads these test headers and always calls the real auth SDK.
const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})
const call = (
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

const roundConfig = {
  teamCount: 2,
  tolerance: 2,
  spread: 1,
  teams: [
    {
      sum: 16,
      players: [
        { id: 'a', name: 'Ada', skill: 9 },
        { id: 'b', name: 'Bo', skill: 7 },
      ],
    },
    {
      sum: 15,
      players: [
        { id: 'c', name: 'Cy', skill: 8 },
        { id: 'd', name: 'Di', skill: 7 },
      ],
    },
  ],
  benchedIds: ['e'],
}

test('unauthenticated data routes refuse access and public assets remain public', async () => {
  for (const [path, method] of [
    ['/api/players', 'GET'],
    ['/api/players', 'POST'],
    ['/api/players/absent', 'PATCH'],
    ['/api/players/absent', 'DELETE'],
    ['/api/rounds', 'GET'],
    ['/api/rounds', 'POST'],
    ['/api/rounds/absent', 'DELETE'],
  ]) {
    const response = await call(path!, undefined, method)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(await (await call('/')).text()).toBe('public page')
  expect((await call('/api/health')).status).toBe(200)
})

test('players can be added in bulk, renamed, rated, benched and removed by their owner only', async () => {
  const created = await call('/api/players', 'alice', 'POST', {
    players: [
      { name: '  Ada  ', skill: 9 },
      { name: 'Bo', skill: 4 },
    ],
  })
  expect(created.status).toBe(201)
  const { players } = (await created.json()) as {
    players: { id: string; name: string; skill: number; sittingOut: boolean }[]
  }
  expect(players).toHaveLength(2)
  expect(players[0]).toMatchObject({ name: 'Ada', skill: 9, sittingOut: false })

  expect(
    ((await (await call('/api/players', 'alice')).json()) as { players: unknown[] })
      .players,
  ).toHaveLength(2)
  expect(
    ((await (await call('/api/players', 'bob')).json()) as { players: unknown[] })
      .players,
  ).toHaveLength(0)

  const id = players[1]!.id
  const patched = await call(`/api/players/${id}`, 'alice', 'PATCH', {
    name: 'Bea',
    skill: 6,
    sittingOut: true,
  })
  expect(patched.status).toBe(200)
  expect(await patched.json()).toMatchObject({
    player: { name: 'Bea', skill: 6, sittingOut: true },
  })

  expect(
    (await call(`/api/players/${id}`, 'bob', 'PATCH', { skill: 2 })).status,
  ).toBe(404)
  expect((await call(`/api/players/${id}`, 'bob', 'DELETE')).status).toBe(404)
  expect((await call(`/api/players/${id}`, 'alice', 'DELETE')).status).toBe(200)
  expect(
    ((await (await call('/api/players', 'alice')).json()) as { players: unknown[] })
      .players,
  ).toHaveLength(1)
})

test('rounds are saved with a snapshot and stay private to their owner', async () => {
  const created = await call('/api/rounds', 'carol', 'POST', {
    config: roundConfig,
  })
  expect(created.status).toBe(201)
  const { round } = (await created.json()) as { round: { id: string } }
  const listed = (await (await call('/api/rounds', 'carol')).json()) as {
    rounds: { config: { teamCount: number; benchedIds: string[] } }[]
  }
  expect(listed.rounds).toHaveLength(1)
  expect(listed.rounds[0]!.config.teamCount).toBe(2)
  expect(listed.rounds[0]!.config.benchedIds).toEqual(['e'])

  expect(
    ((await (await call('/api/rounds', 'dave')).json()) as { rounds: unknown[] })
      .rounds,
  ).toHaveLength(0)
  expect((await call(`/api/rounds/${round.id}`, 'dave', 'DELETE')).status).toBe(
    404,
  )
  expect(
    (await call(`/api/rounds/${round.id}`, 'carol', 'DELETE')).status,
  ).toBe(200)
})

test('role tags round-trip, reject unknown ids and survive in round snapshots', async () => {
  const created = await call('/api/players', 'erin', 'POST', {
    players: [
      { name: 'Sniper Sam', skill: 8, tags: ['sniper', 'igl'] },
      { name: 'Plain Pat', skill: 5 },
    ],
  })
  expect(created.status).toBe(201)
  const { players } = (await created.json()) as {
    players: { id: string; name: string; tags: string[] }[]
  }
  expect(players[0]!.tags).toEqual(['sniper', 'igl'])
  expect(players[1]!.tags).toEqual([])

  const id = players[1]!.id
  const patched = await call(`/api/players/${id}`, 'erin', 'PATCH', {
    tags: ['antipush', 'sniper', 'sniper'],
  })
  expect(patched.status).toBe(200)
  expect(await patched.json()).toMatchObject({
    player: { tags: ['sniper', 'antipush'] },
  })

  for (const tags of [['wizard'], 'sniper', [1], ['sniper', 'sniper', 'nope']]) {
    expect((await call(`/api/players/${id}`, 'erin', 'PATCH', { tags })).status).toBe(
      400,
    )
  }

  const listed = (await (await call('/api/players', 'erin')).json()) as {
    players: { name: string; tags: string[] }[]
  }
  expect(listed.players[1]!.tags).toEqual(['sniper', 'antipush'])

  const withTags = {
    ...roundConfig,
    teams: [
      {
        sum: 13,
        players: [{ id: 'a', name: 'Sam', skill: 8, tags: ['sniper'] }],
      },
      {
        sum: 5,
        players: [{ id: 'b', name: 'Pat', skill: 5, tags: ['sniper', 'antipush'] }],
      },
    ],
  }
  expect(
    (await call('/api/rounds', 'erin', 'POST', { config: withTags })).status,
  ).toBe(201)
  const rounds = (await (await call('/api/rounds', 'erin')).json()) as {
    rounds: { config: { teams: { players: { tags: string[] }[] }[] } }[]
  }
  expect(rounds.rounds[0]!.config.teams[1]!.players[0]!.tags).toEqual([
    'sniper',
    'antipush',
  ])
})

test('rejects foreign and absent origins, spoofing, malformed input and oversized bodies', async () => {
  expect(
    (
      await call(
        '/api/players',
        'alice',
        'POST',
        { name: 'Mallory', skill: 5 },
        'https://foreign.example',
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.request(
        'https://app.example.test/api/players',
        { method: 'POST', headers: { 'test-user': 'alice' } },
        env,
      )
    ).status,
  ).toBe(403)

  for (const body of [
    { name: ' ', skill: 5 },
    { name: 'Zero', skill: 0 },
    { name: 'Eleven', skill: 11 },
    { name: 'Half', skill: 5.5 },
    { name: 'Sneaky', skill: 5, ownerSub: 'bob' },
    { players: [] },
    { players: [{ name: 'Ok', skill: 5 }, { name: '', skill: 5 }] },
    [],
    null,
  ]) {
    expect((await call('/api/players', 'alice', 'POST', body)).status).toBe(400)
  }

  expect(
    (
      await call('/api/players', 'alice', 'POST', {
        players: Array.from({ length: 51 }, (_, index) => ({
          name: `Player ${index}`,
          skill: 5,
        })),
      })
    ).status,
  ).toBe(400)

  expect(
    (await call('/api/players', 'alice', 'POST', { name: 'x'.repeat(80_000), skill: 5 }))
      .status,
  ).toBe(413)

  expect(
    (
      await call('/api/rounds', 'alice', 'POST', {
        config: { ...roundConfig, teamCount: 3 },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call('/api/rounds', 'alice', 'POST', {
        config: { ...roundConfig, tolerance: -1 },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call('/api/rounds', 'alice', 'POST', {
        config: {
          ...roundConfig,
          teams: [{ sum: 1, players: [{ id: 'a', name: 'Ada', skill: 99 }] }],
        },
      })
    ).status,
  ).toBe(400)
})

test('missing database reports setup and local preview identity never activates on hosted origins', async () => {
  const noDb = await app.request(
    'https://app.example.test/api/players',
    { headers: { 'test-user': 'alice' } },
    { ...env, DB: undefined },
  )
  expect(noDb.status).toBe(503)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})
