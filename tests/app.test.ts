import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { compactLog, createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'
import {
  FLAT_K_FORMULA,
  RATING_FORMULA,
  replay,
  skillFromElo,
  type MatchInput,
  type MatchRoster,
  type RatingEvent,
} from '../src/shared/elo'
import type { Database } from '../src/worker/db'

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
  // K is the account setting from a player's first match: no provisional window.
  expect(await eloOf('Ada')).toBe(516)
  expect(await eloOf('Bo')).toBe(516)
  expect(await eloOf('Cy')).toBe(484)
  expect(await eloOf('Di')).toBe(484)

  let log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.kFactor).toBe(32)
  expect(log.events).toHaveLength(1)
  const matchId = log.events[0]!.id
  expect(log.events[0]!.kind).toBe('match')
  expect(log.events[0]!.teams![0]!.players[0]).toMatchObject({
    name: 'Ada',
    delta: 16,
    eloBefore: 500,
    eloAfter: 516,
  })

  // Formula and K are server-stamped; a client cannot supply them.
  expect(
    (await call('/api/matches', 'frank', 'POST', { ...body, formula: 4, k: 64 }))
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
  expect(await eloOf('Ada')).toBe(484)
  expect(await eloOf('Cy')).toBe(516)

  // K is forward-only: changing it never replays old matches.
  expect((await call('/api/settings', 'frank', 'PUT', { kFactor: 7 })).status).toBe(400)
  const tuned = await call('/api/settings', 'frank', 'PUT', { kFactor: 8 })
  expect(tuned.status).toBe(200)
  expect((await (await call('/api/settings', 'frank')).json()) as { kFactor: number }).toEqual(
    { kFactor: 8 },
  )
  expect(await eloOf('Ada')).toBe(484)
  expect(await eloOf('Cy')).toBe(516)

  // Editing keeps the K the match was rated with, not the new setting.
  expect(
    (
      await call(`/api/matches/${matchId}`, 'frank', 'PATCH', {
        input: { ...body, winner: 0 },
      })
    ).status,
  ).toBe(200)
  expect(await eloOf('Ada')).toBe(516)
  expect(await eloOf('Cy')).toBe(484)
  expect(
    (
      await call(`/api/matches/${matchId}`, 'frank', 'PATCH', {
        input: { ...body, winner: 1 },
      })
    ).status,
  ).toBe(200)
  expect(await eloOf('Ada')).toBe(484)
  expect(await eloOf('Cy')).toBe(516)

  // A manual rating lands in the same log and survives the match's deletion.
  const adjusted = await call(`/api/players/${ada.id}/elo`, 'frank', 'POST', {
    elo: 700,
    reason: 'VOD review',
  })
  expect(adjusted.status).toBe(200)
  expect(((await adjusted.json()) as { player: PlayerRow }).player.elo).toBe(700)
  log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.events.map((event) => event.kind)).toEqual(['match', 'adjust'])

  // A player with match history is no longer pinned: removing them archives the
  // row instead of answering 409 (the archive test below covers the ratings).
  const removed = await call(`/api/matches/${matchId}`, 'frank', 'DELETE')
  expect(removed.status).toBe(200)
  log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.events.map((event) => event.kind)).toEqual(['adjust'])
  expect(await eloOf('Ada')).toBe(700)
  expect(await eloOf('Cy')).toBe(500)

  // With the match gone only a manual edit remains. Removing the player takes
  // them off the roster but keeps that edit in the log, so the history stays
  // readable and no rating is rewritten.
  expect((await call(`/api/players/${ada.id}`, 'frank', 'DELETE')).status).toBe(200)
  expect((await listed()).some((player) => player.id === ada.id)).toBe(false)
  log = (await (await call('/api/matches', 'frank')).json()) as Logged
  expect(log.events.map((event) => event.kind)).toEqual(['adjust'])
  expect((await call(`/api/players/${byName.get('Cy')!.id}`, 'frank', 'DELETE')).status).toBe(
    200,
  )

  // Another account sees none of it.
  const strangers = (await (await call('/api/matches', 'gina')).json()) as Logged
  expect(strangers.events).toHaveLength(0)
  expect((await call(`/api/matches/${matchId}`, 'gina', 'DELETE')).status).toBe(404)
})

test('editing a v4 match keeps its stamped formula and K after the account K changes', async () => {
  type PlayerRow = { id: string; name: string; elo: number }
  type Logged = {
    events: {
      id: string
      kind: string
      teams?: { players: { name: string; delta: number }[] }[]
    }[]
  }
  const created = await call('/api/players', 'jules', 'POST', {
    players: [
      { name: 'Ada', skill: 5 },
      { name: 'Bo', skill: 5 },
    ],
  })
  expect(created.status).toBe(201)
  const roster = ((await created.json()) as { players: PlayerRow[] }).players
  const byName = new Map(roster.map((player) => [player.name, player]))
  const team = (name: string) => ({
    players: [{ id: byName.get(name)!.id, name, damage: 100, tracked: true }],
  })
  const body = { label: 'Duel', winner: 0, teams: [team('Ada'), team('Bo')] }
  const eloOf = async (name: string) =>
    ((await (await call('/api/players', 'jules')).json()) as { players: PlayerRow[] }).players
      .find((player) => player.name === name)!.elo
  const stored = async (id: string) =>
    JSON.parse(
      (
        await env.DB!.prepare('SELECT payload FROM rating_events WHERE id = ? AND owner_sub = ?')
          .bind(id, 'jules')
          .first<{ payload: string }>()
      )!.payload,
    ) as { formula?: number; k?: number }

  // The first match pins the legacy K (32) that unmarked events replay with.
  expect((await call('/api/matches', 'jules', 'POST', body)).status).toBe(201)
  // Lower the account K before this one, so it is stamped with K 8.
  expect((await call('/api/settings', 'jules', 'PUT', { kFactor: 8 })).status).toBe(200)
  expect((await call('/api/matches', 'jules', 'POST', { ...body, winner: 1 })).status).toBe(
    201,
  )
  const second = ((await (await call('/api/matches', 'jules')).json()) as Logged).events[1]!
  expect(await stored(second.id)).toMatchObject({ formula: 4, k: 8 })
  expect(second.teams![1]!.players[0]!.delta).toBe(4)
  const settled = { ada: await eloOf('Ada'), bo: await eloOf('Bo') }

  // Raise the account K, then edit the match. A v4 event keeps the K it was
  // rated with: the new 16 would move Bo by 7 and the legacy 32 by 17.
  expect((await call('/api/settings', 'jules', 'PUT', { kFactor: 16 })).status).toBe(200)
  expect(
    (
      await call(`/api/matches/${second.id}`, 'jules', 'PATCH', {
        input: { ...body, label: 'Duel (fixed)', winner: 1 },
      })
    ).status,
  ).toBe(200)
  expect(await stored(second.id)).toMatchObject({ formula: 4, k: 8 })
  expect({ ada: await eloOf('Ada'), bo: await eloOf('Bo') }).toEqual(settled)
  expect(
    ((await (await call('/api/matches', 'jules')).json()) as Logged).events[1]!.teams![1]!
      .players[0]!.delta,
  ).toBe(4)
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
  expect(log.events[0]!.teams![0]!.players[0]!.delta).toBe(-11)
  expect(log.events[0]!.teams![2]!.players[0]!.delta).toBe(21)
  expect(await eloOf('Ana')).toBe(489)
  expect(await eloOf('Cal')).toBe(521)

  // Editing the winner of a three-team match replays the whole field.
  const matchId = log.events[0]!.id
  const edited = await call(`/api/matches/${matchId}`, 'iris', 'PATCH', {
    input: { ...body, winner: 0 },
  })
  expect(edited.status).toBe(200)
  expect(await eloOf('Ana')).toBe(521)
  expect(await eloOf('Cal')).toBe(489)

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

test('deleting a player archives them and never moves anyone elo', async () => {
  type RosterPlayer = { id: string; name: string; elo: number }
  type LogPlayer = {
    id: string | null
    name: string
    damage: number
    tracked: boolean
    eloBefore: number
    eloAfter: number
    delta: number
  }
  type LogEvent = {
    id: string
    kind: string
    position: number
    label?: string
    winner?: number
    teams?: { players: LogPlayer[] }[]
  }
  type Log = { events: LogEvent[] }

  const created = await call('/api/players', 'ivy', 'POST', {
    players: [
      { name: 'Ada', skill: 6 },
      { name: 'Bo', skill: 5 },
      { name: 'Cy', skill: 7 },
      { name: 'Di', skill: 4 },
    ],
  })
  expect(created.status).toBe(201)
  const roster = ((await created.json()) as { players: RosterPlayer[] }).players
  const [ada, bo, cy, di] = roster
  expect(di).toBeDefined()

  const duel = (
    left: RosterPlayer,
    leftDamage: number,
    right: RosterPlayer,
    rightDamage: number,
    winner: number,
  ) => ({
    label: '',
    winner,
    teams: [
      {
        players: [
          { id: left.id, name: left.name, damage: leftDamage, tracked: true },
        ],
      },
      {
        players: [
          { id: right.id, name: right.name, damage: rightDamage, tracked: true },
        ],
      },
    ],
  })

  // Ada plays both matches, so her second rating is the one a vanished opponent
  // would silently re-rate.
  expect(
    (await call('/api/matches', 'ivy', 'POST', duel(ada!, 120, bo!, 90, 0))).status,
  ).toBe(201)
  expect(
    (await call('/api/matches', 'ivy', 'POST', duel(ada!, 80, cy!, 140, 1))).status,
  ).toBe(201)

  const listed = async () =>
    (await (await call('/api/matches', 'ivy')).json()) as Log
  const rosterNow = async () =>
    (
      (await (await call('/api/players', 'ivy')).json()) as {
        players: RosterPlayer[]
      }
    ).players
  const snapshot = (log: Log) =>
    log.events.map((event) => ({
      id: event.id,
      position: event.position,
      players: (event.teams ?? []).flatMap((team) =>
        team.players.map((player) => ({
          id: player.id,
          name: player.name,
          eloBefore: player.eloBefore,
          eloAfter: player.eloAfter,
          delta: player.delta,
        })),
      ),
    }))

  const logBefore = await listed()
  expect(logBefore.events).toHaveLength(2)
  const elosBefore = new Map(
    (await rosterNow()).map((player) => [player.name, player.elo]),
  )

  // Cy has match history, which used to answer 409.
  expect((await call(`/api/players/${cy!.id}`, 'ivy', 'DELETE')).status).toBe(200)

  const survivors = await rosterNow()
  expect(survivors.map((player) => player.name)).toEqual(['Ada', 'Bo', 'Di'])
  for (const player of survivors)
    expect(player.elo).toBe(elosBefore.get(player.name)!)

  // A no-op reorder replays the whole log from position 0 with unchanged input.
  const first = logBefore.events[0]!
  const replayed = await call(`/api/matches/${first.id}`, 'ivy', 'PATCH', {
    position: 0,
  })
  expect(replayed.status).toBe(200)
  expect(
    ((await replayed.json()) as { players: RosterPlayer[] }).players.map(
      (player) => player.name,
    ),
  ).toEqual(['Ada', 'Bo', 'Di'])

  // Every stored rating is byte-identical, Cy's rows included: the history is
  // kept, not orphaned.
  const logAfter = await listed()
  expect(snapshot(logAfter)).toEqual(snapshot(logBefore))
  expect(
    logAfter.events.flatMap((event) =>
      (event.teams ?? []).flatMap((team) =>
        team.players.filter((player) => player.id === cy!.id),
      ),
    ),
  ).toHaveLength(1)
  for (const player of await rosterNow())
    expect(player.elo).toBe(elosBefore.get(player.name)!)

  // A lineup that already names an archived player stays editable.
  const archived = logAfter.events.find((event) =>
    (event.teams ?? []).some((team) =>
      team.players.some((player) => player.id === cy!.id),
    ),
  )!
  const resaved = await call(`/api/matches/${archived.id}`, 'ivy', 'PATCH', {
    input: {
      label: archived.label ?? '',
      winner: archived.winner!,
      teams: (archived.teams ?? []).map((team) => ({
        players: team.players.map((player) => ({
          id: player.id,
          name: player.name,
          damage: player.damage,
          tracked: player.tracked,
        })),
      })),
    },
  })
  expect(resaved.status).toBe(200)
  expect(snapshot(await listed())).toEqual(snapshot(logBefore))

  // A new match may not add them, and they can no longer be edited or re-rated.
  expect(
    (await call('/api/matches', 'ivy', 'POST', duel(ada!, 100, cy!, 100, 0))).status,
  ).toBe(400)
  expect(
    (await call(`/api/players/${cy!.id}`, 'ivy', 'PATCH', { name: 'Ghost' })).status,
  ).toBe(404)
  expect(
    (await call(`/api/players/${cy!.id}/elo`, 'ivy', 'POST', { elo: 500 })).status,
  ).toBe(404)
})

type SeedPlayer = { id: string; name: string; elo: number }

/**
 * Writes `count` duels straight into D1 and then stores the ratings a replay
 * produces, which is the state every write path leaves behind. Building the log
 * through the API would be a thousand round trips per fixture.
 */
async function seedLog(user: string, count: number, legacyAt = -1) {
  const db = env.DB as unknown as Database
  const created = await call('/api/players', user, 'POST', {
    players: [
      { name: 'Ada', skill: 6 },
      { name: 'Bo', skill: 5 },
      { name: 'Cy', skill: 4 },
    ],
  })
  const players = ((await created.json()) as { players: SeedPlayer[] }).players
  const [ada, bo, cy] = players as [SeedPlayer, SeedPlayer, SeedPlayer]
  const roster: MatchRoster[] = players.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.elo,
  }))
  const events: RatingEvent[] = Array.from({ length: count }, (_, index) => {
    const payload: MatchInput = {
      label: `duel ${index}`,
      winner: index % 2,
      formula: FLAT_K_FORMULA,
      k: 32,
      teams: [
        {
          players: [
            { id: ada.id, name: 'Ada', damage: 100, tracked: true },
            { id: cy.id, name: 'Cy', damage: 60, tracked: true },
          ],
        },
        { players: [{ id: bo.id, name: 'Bo', damage: 90, tracked: true }] },
      ],
    }
    if (index === legacyAt) payload.formula = RATING_FORMULA
    return {
      id: `evt-${user}-${index}`,
      position: index,
      kind: 'match',
      createdAt: index + 1,
      updatedAt: index + 1,
      payload,
    }
  })
  const { elos, outcomes } = replay(events, roster, 32, 32)

  for (let start = 0; start < events.length; start += 20) {
    const statements = events.slice(start, start + 20).flatMap((event) => {
      const outcome = outcomes.get(event.id)
      if (!outcome || outcome.kind !== 'match') return []
      const rows = outcome.result.teams.flatMap((team, teamIndex) =>
        team.players.map((player, slot) => ({ player, slot: `${teamIndex}:${slot}` })),
      )
      return [
        db
          .prepare(
            'INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            event.id,
            user,
            event.position,
            'match',
            JSON.stringify(event.payload),
            event.createdAt,
            event.updatedAt,
          ),
        ...rows.map(({ player, slot }) =>
          db
            .prepare(
              'INSERT INTO rating_results (event_id, owner_sub, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              event.id,
              user,
              slot,
              player.id,
              player.name,
              player.eloBefore,
              player.eloAfter,
              player.delta,
            ),
        ),
      ]
    })
    await db.batch(statements)
  }
  await db.batch(
    players.map((player) => {
      const elo = elos.get(player.id) ?? player.elo
      return db
        .prepare('UPDATE players SET elo = ?, skill = ? WHERE id = ? AND owner_sub = ?')
        .bind(elo, skillFromElo(elo), player.id, user)
    }),
  )
  return { db, players, events, roster }
}

const rosterNow = async (user: string) =>
  (
    (await (await call('/api/players', user)).json()) as {
      players: { id: string; elo: number }[]
    }
  ).players

const rowCounts = async (db: Database, user: string) =>
  (await db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM rating_events WHERE owner_sub = ?) AS events, (SELECT COUNT(*) FROM rating_results WHERE owner_sub = ?) AS results',
    )
    .bind(user, user)
    .first<{ events: number; results: number }>())!

test(
  'a full log is squashed to its newest half without moving a rating',
  async () => {
    const user = 'squash-main'
    const { db, events, roster } = await seedLog(user, 1000)
    const before = await rosterNow(user)
    const elosBefore = new Map(before.map((player) => [player.id, player.elo]))

    // Nothing has gone missing yet, so there is nothing to explain.
    expect(
      ((await (await call('/api/matches', user)).json()) as { squashed: unknown })
        .squashed,
    ).toBeNull()

    expect(await compactLog(db, user)).toEqual({ removed: 500, kept: 500 })
    expect(await rowCounts(db, user)).toEqual({ events: 500, results: 1500 })

    for (const player of await rosterNow(user))
      expect(player.elo).toBe(elosBefore.get(player.id)!)

    // The anchor is the rating at the cut, not the final one: replaying only the
    // deleted events reproduces it, and the kept half builds on top.
    const boundary = replay(events.slice(0, 500), roster, 32, 32)
    const rows = await db
      .prepare('SELECT id, elo, base_elo FROM players WHERE owner_sub = ?')
      .bind(user)
      .all<{ id: string; elo: number; base_elo: number }>()
    for (const row of rows.results) {
      expect(row.base_elo).toBe(boundary.elos.get(row.id)!)
      expect(row.elo).toBe(elosBefore.get(row.id)!)
    }

    const log = (await (await call('/api/matches', user)).json()) as {
      events: { position: number }[]
      squashed: { removed: number; at: number } | null
    }
    expect(log.events).toHaveLength(500)
    expect(log.events[0]!.position).toBe(500)
    // The list can say why 500 entries vanished.
    expect(log.squashed?.removed).toBe(500)
    expect(log.squashed?.at).toBeGreaterThan(0)
    expect(before).toHaveLength(3)
  },
  60_000,
)

test(
  'adding a match at the cap squashes instead of refusing',
  async () => {
    const user = 'squash-cap'
    const { db, players } = await seedLog(user, 1000)
    const elosBefore = new Map(
      (await rosterNow(user)).map((player) => [player.id, player.elo]),
    )
    const [ada, bo] = players as [SeedPlayer, SeedPlayer]

    const response = await call('/api/matches', user, 'POST', {
      label: 'after squash',
      winner: 0,
      teams: [
        { players: [{ id: ada.id, name: 'Ada', damage: 100, tracked: true }] },
        { players: [{ id: bo.id, name: 'Bo', damage: 70, tracked: true }] },
      ],
    })
    expect(response.status).toBe(201)
    expect((await rowCounts(db, user)).events).toBe(501)

    const log = (await (await call('/api/matches', user)).json()) as {
      events: {
        label?: string
        position: number
        teams?: { players: { eloBefore: number }[] }[]
      }[]
    }
    expect(log.events[0]!.position).toBe(500)
    const added = log.events.find((event) => event.label === 'after squash')!
    // Rated from the pre-squash ratings: the fold left nobody behind.
    expect(added.teams![0]!.players[0]!.eloBefore).toBe(elosBefore.get(ada.id)!)
    expect(added.teams![1]!.players[0]!.eloBefore).toBe(elosBefore.get(bo.id)!)
  },
  60_000,
)

test(
  'a squash never keeps a count-dependent event behind a deleted prefix',
  async () => {
    // Formula 2 doubles K from a count built out of the log, so an event of that
    // era has to fall inside the deleted prefix.
    const user = 'squash-legacy'
    const { db } = await seedLog(user, 300, 200)
    const before = await rosterNow(user)
    expect(await compactLog(db, user, 100)).toEqual({ removed: 201, kept: 99 })
    for (const player of await rosterNow(user))
      expect(player.elo).toBe(before.find((entry) => entry.id === player.id)!.elo)

    // A legacy event already inside the prefix does not shrink the kept window.
    const clean = 'squash-legacy-prefix'
    const second = await seedLog(clean, 300, 10)
    const beforeClean = await rosterNow(clean)
    expect(await compactLog(second.db, clean, 100)).toEqual({
      removed: 200,
      kept: 100,
    })
    for (const player of await rosterNow(clean))
      expect(player.elo).toBe(beforeClean.find((entry) => entry.id === player.id)!.elo)
  },
  60_000,
)

test(
  'a squash folds an archived player without moving anyone else',
  async () => {
    const user = 'squash-archive'
    const { db, players, events, roster } = await seedLog(user, 200)
    const archived = players[2]!
    expect((await call(`/api/players/${archived.id}`, user, 'DELETE')).status).toBe(200)
    const before = await rosterNow(user)

    expect(await compactLog(db, user, 100)).toEqual({ removed: 100, kept: 100 })
    for (const player of await rosterNow(user))
      expect(player.elo).toBe(before.find((entry) => entry.id === player.id)!.elo)

    // The archived row still seeds the replay, so its anchor moved too.
    const row = await db
      .prepare('SELECT base_elo FROM players WHERE id = ?')
      .bind(archived.id)
      .first<{ base_elo: number }>()
    expect(row!.base_elo).toBe(
      replay(events.slice(0, 100), roster, 32, 32).elos.get(archived.id)!,
    )
  },
  60_000,
)

test(
  'editing after a squash replays from the folded anchor',
  async () => {
    const user = 'squash-edit'
    const { db, events, roster } = await seedLog(user, 200)
    expect(await compactLog(db, user, 100)).toEqual({ removed: 100, kept: 100 })

    const log = (await (await call('/api/matches', user)).json()) as {
      events: { id: string }[]
    }
    const newest = log.events[log.events.length - 1]!
    expect((await call(`/api/matches/${newest.id}`, user, 'DELETE')).status).toBe(200)

    const boundary = replay(events.slice(0, 100), roster, 32, 32)
    const folded = roster.map((player) => ({
      ...player,
      baseElo: boundary.elos.get(player.id) ?? player.baseElo,
    }))
    const expected = replay(events.slice(100, 199), folded, 32, 32)
    for (const player of await rosterNow(user))
      expect(player.elo).toBe(expected.elos.get(player.id)!)
  },
  60_000,
)
