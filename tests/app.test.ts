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
  version: 2,
  teamCount: 2,
  tolerance: 200,
  spread: 100,
  teams: [
    {
      sum: 1600,
      players: [
        { id: 'a', name: 'Ada', elo: 900 },
        { id: 'b', name: 'Bo', elo: 700 },
      ],
    },
    {
      sum: 1500,
      players: [
        { id: 'c', name: 'Cy', elo: 800 },
        { id: 'd', name: 'Di', elo: 700 },
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
    ['/api/matches', 'GET'],
    ['/api/matches', 'POST'],
    ['/api/matches/absent', 'PATCH'],
    ['/api/matches/absent', 'DELETE'],
    ['/api/players/absent/elo', 'POST'],
    ['/api/settings', 'GET'],
    ['/api/settings', 'PUT'],
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
      { name: '  Ada  ', username: ' ada#1 ', skill: 9 },
      { name: 'Bo', skill: 4 },
    ],
  })
  expect(created.status).toBe(201)
  const { players } = (await created.json()) as {
    players: {
      id: string
      name: string
      username: string
      skill: number
      sittingOut: boolean
    }[]
  }
  expect(players).toHaveLength(2)
  expect(players[0]).toMatchObject({
    name: 'Ada',
    username: 'ada#1',
    skill: 9,
    elo: 900,
    sittingOut: false,
  })
  expect(players[1]!.username).toBe('')

  // Detail edits carry no rating, so elo, skill and the log stay untouched.
  const details = await call(`/api/players/${players[0]!.id}`, 'alice', 'PATCH', {
    name: 'Ada L',
    username: 'ada-l',
  })
  expect(details.status).toBe(200)
  expect(await details.json()).toMatchObject({
    player: { name: 'Ada L', username: 'ada-l', skill: 9, elo: 900 },
  })
  const cleared = await call(`/api/players/${players[0]!.id}`, 'alice', 'PATCH', {
    username: '',
  })
  expect(await cleared.json()).toMatchObject({
    player: { name: 'Ada L', username: '', skill: 9, elo: 900 },
  })

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
    player: { name: 'Bea', username: '', skill: 6, elo: 600, sittingOut: true },
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
        sum: 800,
        players: [{ id: 'a', name: 'Sam', elo: 800, tags: ['sniper'] }],
      },
      {
        sum: 500,
        players: [{ id: 'b', name: 'Pat', elo: 500, tags: ['sniper', 'antipush'] }],
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
    { name: 'Long handle', skill: 5, username: 'x'.repeat(33) },
    { name: 'Bad handle', skill: 5, username: 7 },
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
          teams: [{ sum: 1, players: [{ id: 'a', name: 'Ada', elo: 9900 }] }],
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

test('matches tune elo, replay edits, log manual ratings and stay private', async () => {
  type PlayerRow = { id: string; name: string; elo: number; skill: number }
  type Logged = {
    kFactor: number
    events: {
      id: string
      kind: string
      position: number
      winner?: number
      teams?: {
        players: {
          name: string
          delta: number
          eloBefore: number
          eloAfter: number
        }[]
      }[]
    }[]
  }

  const created = await call('/api/players', 'frank', 'POST', {
    players: [
      { name: 'Ada', skill: 5 },
      { name: 'Bo', skill: 5 },
      { name: 'Cy', skill: 5 },
      { name: 'Di', skill: 5 },
    ],
  })
  expect(created.status).toBe(201)
  const roster = ((await created.json()) as { players: PlayerRow[] }).players
  const byName = new Map(roster.map((player) => [player.name, player]))
  const ada = byName.get('Ada')!
  const team = (names: string[]) => ({
    players: names.map((name) => ({
      id: byName.get(name)!.id,
      name,
      damage: 100,
      tracked: true,
    })),
  })
  const body = {
    label: 'Scrim',
    winner: 0,
    teams: [team(['Ada', 'Bo']), team(['Cy', 'Di'])],
  }
  const listed = async () =>
    ((await (await call('/api/players', 'frank')).json()) as {
      players: PlayerRow[]
    }).players
  const eloOf = async (name: string) =>
    (await listed()).find((player) => player.name === name)!.elo

  const logged = await call('/api/matches', 'frank', 'POST', body)
  expect(logged.status).toBe(201)
  // New players are provisional: the first five rated matches use double K.
  expect(await eloOf('Ada')).toBe(532)
  expect(await eloOf('Bo')).toBe(532)
  expect(await eloOf('Cy')).toBe(468)
  expect(await eloOf('Di')).toBe(468)

  let log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.kFactor).toBe(32)
  expect(log.events).toHaveLength(1)
  const matchId = log.events[0]!.id
  expect(log.events[0]!.kind).toBe('match')
  expect(log.events[0]!.teams![0]!.players[0]).toMatchObject({
    name: 'Ada',
    delta: 32,
    eloBefore: 500,
    eloAfter: 532,
  })

  // Formula and K are server-stamped; a client cannot supply them.
  expect(
    (await call('/api/matches', 'frank', 'POST', { ...body, formula: 2, k: 64 }))
      .status,
  ).toBe(400)

  // The first three teams, a winner outside 0/1 and all-random teams are invalid.
  expect(
    (await call('/api/matches', 'frank', 'POST', { ...body, teams: [team(['Ada', 'Bo'])] }))
      .status,
  ).toBe(400)
  expect((await call('/api/matches', 'frank', 'POST', { ...body, winner: 2 })).status).toBe(
    400,
  )
  expect(
    (
      await call('/api/matches', 'frank', 'POST', {
        label: '',
        winner: 0,
        teams: [
          { players: [{ id: 'r1', name: 'Random 1', damage: 100, tracked: false }] },
          { players: [{ id: 'r2', name: 'Random 2', damage: 100, tracked: false }] },
        ],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call('/api/matches', 'frank', 'POST', {
        ...body,
        teams: [
          { players: [{ id: ada.id, name: 'Ada', damage: 100, tracked: true }] },
          { players: [{ id: ada.id, name: 'Ada', damage: 100, tracked: true }] },
        ],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call('/api/matches', 'frank', 'POST', {
        ...body,
        teams: [
          { players: [{ id: 'nope', name: 'Ghost', damage: 100, tracked: true }] },
          { players: [{ id: byName.get('Cy')!.id, name: 'Cy', damage: 0, tracked: true }] },
        ],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call('/api/matches', 'frank', 'POST', {
        ...body,
        teams: [
          {
            players: [
              { id: ada.id, name: 'Ada', damage: 0, tracked: true },
              { id: byName.get('Bo')!.id, name: 'Bo', damage: 0, tracked: true },
            ],
          },
          {
            players: [
              { id: byName.get('Cy')!.id, name: 'Cy', damage: 0, tracked: true },
              { id: byName.get('Di')!.id, name: 'Di', damage: 0, tracked: true },
            ],
          },
        ],
      })
    ).status,
  ).toBe(400)

  // Editing the winner replays the match.
  const edited = await call(`/api/matches/${matchId}`, 'frank', 'PATCH', {
    input: { ...body, winner: 1 },
  })
  expect(edited.status).toBe(200)
  expect(await eloOf('Ada')).toBe(468)
  expect(await eloOf('Cy')).toBe(532)

  // K is forward-only: changing it never replays old matches.
  expect((await call('/api/settings', 'frank', 'PUT', { kFactor: 7 })).status).toBe(400)
  const tuned = await call('/api/settings', 'frank', 'PUT', { kFactor: 8 })
  expect(tuned.status).toBe(200)
  expect((await (await call('/api/settings', 'frank')).json()) as { kFactor: number }).toEqual(
    { kFactor: 8 },
  )
  expect(await eloOf('Ada')).toBe(468)
  expect(await eloOf('Cy')).toBe(532)

  // Editing keeps the K the match was rated with, not the new setting.
  expect(
    (
      await call(`/api/matches/${matchId}`, 'frank', 'PATCH', {
        input: { ...body, winner: 0 },
      })
    ).status,
  ).toBe(200)
  expect(await eloOf('Ada')).toBe(532)
  expect(await eloOf('Cy')).toBe(468)
  expect(
    (
      await call(`/api/matches/${matchId}`, 'frank', 'PATCH', {
        input: { ...body, winner: 1 },
      })
    ).status,
  ).toBe(200)
  expect(await eloOf('Ada')).toBe(468)
  expect(await eloOf('Cy')).toBe(532)

  // A manual rating lands in the same log and survives the match's deletion.
  const adjusted = await call(`/api/players/${ada.id}/elo`, 'frank', 'POST', {
    elo: 700,
    reason: 'VOD review',
  })
  expect(adjusted.status).toBe(200)
  expect(((await adjusted.json()) as { player: PlayerRow }).player.elo).toBe(700)
  log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.events.map((event) => event.kind)).toEqual(['match', 'adjust'])

  // Match history pins a player to the log until those matches are gone.
  expect((await call(`/api/players/${ada.id}`, 'frank', 'DELETE')).status).toBe(409)

  const removed = await call(`/api/matches/${matchId}`, 'frank', 'DELETE')
  expect(removed.status).toBe(200)
  log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.events.map((event) => event.kind)).toEqual(['adjust'])
  expect(await eloOf('Ada')).toBe(700)
  expect(await eloOf('Cy')).toBe(500)

  // With the match gone only a manual edit remains, and the player can leave
  // with it; the adjustment event disappears from the log too.
  expect((await call(`/api/players/${ada.id}`, 'frank', 'DELETE')).status).toBe(200)
  expect((await listed()).some((player) => player.id === ada.id)).toBe(false)
  expect((await call(`/api/players/${byName.get('Cy')!.id}`, 'frank', 'DELETE')).status).toBe(
    200,
  )

  // Another account sees none of it.
  const strangers = (await (await call('/api/matches', 'gina')).json()) as Logged
  expect(strangers.events).toHaveLength(0)
  expect((await call(`/api/matches/${matchId}`, 'gina', 'DELETE')).status).toBe(404)
})

test('a match can have more than two teams', async () => {
  type RosterPlayer = { id: string; name: string; elo: number }
  type Logged = {
    events: {
      id: string
      winner?: number
      teams?: { players: { name: string; delta: number }[] }[]
    }[]
  }
  const created = await call('/api/players', 'iris', 'POST', {
    players: [
      { name: 'Ana', skill: 5 },
      { name: 'Ben', skill: 5 },
      { name: 'Cal', skill: 5 },
    ],
  })
  const roster = ((await created.json()) as { players: RosterPlayer[] }).players
  const byName = new Map(roster.map((player) => [player.name, player]))
  const team = (name: string) => ({
    players: [{ id: byName.get(name)!.id, name, damage: 100, tracked: true }],
  })
  const body = {
    label: 'Three way',
    winner: 2,
    teams: [team('Ana'), team('Ben'), team('Cal')],
  }
  expect((await call('/api/matches', 'iris', 'POST', body)).status).toBe(201)

  const listed = async () =>
    (await (await call('/api/matches', 'iris')).json()) as Logged
  const eloOf = async (name: string) =>
    ((await (await call('/api/players', 'iris')).json()) as {
      players: RosterPlayer[]
    }).players.find((player) => player.name === name)!.elo

  let log = await listed()
  expect(log.events).toHaveLength(1)
  expect(log.events[0]!.winner).toBe(2)
  expect(log.events[0]!.teams).toHaveLength(3)
  expect(log.events[0]!.teams![0]!.players[0]!.delta).toBe(-21)
  expect(log.events[0]!.teams![2]!.players[0]!.delta).toBe(43)
  expect(await eloOf('Ana')).toBe(479)
  expect(await eloOf('Cal')).toBe(543)

  // Editing the winner of a three-team match replays the whole field.
  const matchId = log.events[0]!.id
  const edited = await call(`/api/matches/${matchId}`, 'iris', 'PATCH', {
    input: { ...body, winner: 0 },
  })
  expect(edited.status).toBe(200)
  expect(await eloOf('Ana')).toBe(543)
  expect(await eloOf('Cal')).toBe(479)

  // A winner past the last team, and more teams than the app supports, are invalid.
  expect((await call('/api/matches', 'iris', 'POST', { ...body, winner: 3 })).status).toBe(
    400,
  )
  const nineTeams = [
    team('Ana'),
    ...Array.from({ length: 8 }, (_entry, index) => ({
      players: [
        { id: `r${index}`, name: `Random ${index + 1}`, damage: 100, tracked: false },
      ],
    })),
  ]
  expect(
    (await call('/api/matches', 'iris', 'POST', { ...body, teams: nineTeams })).status,
  ).toBe(400)

  log = await listed()
  expect(log.events).toHaveLength(1)
})

test('a match can be reordered within the log', async () => {
  type RosterPlayer = { id: string; name: string }
  type Log = { events: { id: string; position: number }[] }
  const created = await call('/api/players', 'hank', 'POST', {
    players: [
      { name: 'Ace', skill: 5 },
      { name: 'Bee', skill: 5 },
    ],
  })
  const roster = ((await created.json()) as { players: RosterPlayer[] }).players
  const [ace, bee] = roster
  const duel = (winner: number) => ({
    label: '',
    winner,
    teams: [
      { players: [{ id: ace!.id, name: 'Ace', damage: 100, tracked: true }] },
      { players: [{ id: bee!.id, name: 'Bee', damage: 100, tracked: true }] },
    ],
  })
  expect((await call('/api/matches', 'hank', 'POST', duel(0))).status).toBe(201)
  expect((await call('/api/matches', 'hank', 'POST', duel(1))).status).toBe(201)

  const listed = async () =>
    (await (await call('/api/matches', 'hank')).json()) as Log
  let log = await listed()
  const [first, second] = log.events
  expect(log.events.map((event) => event.position)).toEqual([0, 1])

  const moved = await call(`/api/matches/${second!.id}`, 'hank', 'PATCH', {
    position: 0,
  })
  expect(moved.status).toBe(200)
  log = await listed()
  expect(log.events.map((event) => event.id)).toEqual([second!.id, first!.id])
  expect(log.events.map((event) => event.position)).toEqual([0, 1])
  expect(
    (await call(`/api/matches/${second!.id}`, 'hank', 'PATCH', { position: 1.5 }))
      .status,
  ).toBe(400)
})
