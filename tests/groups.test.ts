import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'
import type { Database } from '../src/worker/db'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-groups',
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
        env: { DB: { type: 'd1', name: 'teammaker-groups-test' } },
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
    ASSETS: { fetch: async () => new Response('public page') } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  if (!sub) return null
  const email = request.headers.get('test-email')
  return {
    sub,
    name: request.headers.get('test-name') ?? sub,
    ...(email ? { email } : {}),
  }
})

async function call(
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin: string | null = env.APP_ORIGIN!,
  email?: string,
): Promise<Response> {
  return app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user, 'test-name': `Name ${user}` } : {}),
        ...(email ? { 'test-email': email } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}

type Group = {
  id: string
  name: string
  role: string
  kFactor: number
  tags: GroupTagView[]
  members: { id: string; role: string; isYou: boolean }[]
}
type GroupTagView = { id: string; label: string; short: string }

async function createGroup(user: string, name = 'Test group'): Promise<Group> {
  const response = await call('/api/groups', user, 'POST', { name })
  expect(response.status).toBe(201)
  const { group } = (await response.json()) as { group: Group }
  return group
}

const base = (group: Group, path = '') => `/api/groups/${group.id}${path}`

async function addTag(group: Group, user: string, label: string, short = '') {
  const response = await call(base(group, '/tags'), user, 'POST', { label, short })
  expect(response.status).toBe(201)
  return ((await response.json()) as { tag: GroupTagView }).tag
}

async function invite(group: Group, user: string, role: 'editor' | 'viewer') {
  const response = await call(base(group, '/invites'), user, 'POST', { role })
  expect(response.status).toBe(201)
  const { invite: created } = (await response.json()) as {
    invite: { id: string; url: string; role: string }
  }
  return { ...created, token: created.url.split('/').pop()! }
}

test('groups are created, listed, renamed and archived by their owner', async () => {
  const first = await createGroup('owner-anna', 'Anna’s group')
  expect(first.role).toBe('owner')
  const second = await createGroup('owner-anna', 'Second group')

  const listed = (await (await call('/api/groups', 'owner-anna')).json()) as {
    groups: { id: string; name: string; role: string }[]
  }
  expect(listed.groups).toHaveLength(2)
  expect(new Set(listed.groups.map((group) => group.role))).toEqual(new Set(['owner']))

  const renamed = await call(base(first), 'owner-anna', 'PATCH', { name: 'Renamed' })
  expect(renamed.status).toBe(200)
  expect(((await renamed.json()) as { group: Group }).group.name).toBe('Renamed')

  expect((await call(base(second), 'owner-anna', 'DELETE')).status).toBe(200)
  const after = (await (await call('/api/groups', 'owner-anna')).json()) as {
    groups: unknown[]
  }
  expect(after.groups).toHaveLength(1)
  expect((await call(base(second), 'owner-anna')).status).toBe(404)
})

test('invite links grant their role, can be revoked and can be changed later', async () => {
  const group = await createGroup('share-owner')
  const viewer = await invite(group, 'share-owner', 'viewer')

  const preview = await call(`/api/invites/${viewer.token}`, 'share-bob')
  expect(preview.status).toBe(200)
  expect(await preview.json()).toMatchObject({
    invite: { groupId: group.id, role: 'viewer' },
  })

  // A signed-out visitor holding the link can see what it grants, but joining
  // still needs an account.
  const anonymous = await call(`/api/invites/${viewer.token}`)
  expect(anonymous.status).toBe(200)
  expect(await anonymous.json()).toMatchObject({
    invite: { groupId: group.id, role: 'viewer' },
  })
  expect(
    (await call(`/api/invites/${viewer.token}/accept`, undefined, 'POST')).status,
  ).toBe(401)
  expect(
    (await call(`/api/invites/${viewer.token}/accept`, 'share-bob', 'POST')).status,
  ).toBe(200)

  const detail = (await (await call(base(group), 'share-bob')).json()) as {
    group: Group
  }
  expect(detail.group.role).toBe('viewer')

  const players = await call(base(group, '/players'), 'share-bob')
  expect(players.status).toBe(200)
  expect(
    (await call(base(group, '/players'), 'share-bob', 'POST', { name: 'X', skill: 5 }))
      .status,
  ).toBe(403)
  expect((await call(base(group, '/invites'), 'share-bob', 'POST', { role: 'viewer' })).status).toBe(403)

  // The owner promotes them: an editor can now change the group's data but
  // still cannot manage sharing or delete the group.
  const members = (await (await call(base(group, '/members'), 'share-owner')).json()) as {
    members: { id: string; role: string }[]
  }
  const bob = members.members.find((member) => member.role === 'viewer')!
  expect(
    (await call(base(group, `/members/${bob.id}`), 'share-owner', 'PATCH', {
      role: 'editor',
    })).status,
  ).toBe(200)
  expect(
    (await call(base(group, '/players'), 'share-bob', 'POST', { name: 'X', skill: 5 }))
      .status,
  ).toBe(201)
  expect(
    (await call(base(group, '/invites'), 'share-bob', 'POST', { role: 'viewer' })).status,
  ).toBe(403)
  expect((await call(base(group), 'share-bob', 'DELETE')).status).toBe(403)

  // A revoked link stops working immediately.
  const revoked = await invite(group, 'share-owner', 'editor')
  expect(
    (await call(base(group, `/invites/${revoked.id}`), 'share-owner', 'DELETE')).status,
  ).toBe(200)
  expect((await call(`/api/invites/${revoked.token}`, 'share-carol')).status).toBe(404)
  expect(
    (await call(`/api/invites/${revoked.token}/accept`, 'share-carol', 'POST')).status,
  ).toBe(404)

  // Removing a member ends their access, and the owner cannot be removed.
  expect(
    (await call(base(group, `/members/${bob.id}`), 'share-owner', 'DELETE')).status,
  ).toBe(200)
  expect((await call(base(group), 'share-bob')).status).toBe(404)
  const ownerRow = (await (await call(base(group), 'share-owner')).json()) as {
    group: Group
  }
  const owner = ownerRow.group.members.find((member) => member.role === 'owner')!
  expect(
    (await call(base(group, `/members/${owner.id}`), 'share-owner', 'DELETE')).status,
  ).toBe(400)
  expect(
    (await call(base(group, `/members/${owner.id}`), 'share-owner', 'PATCH', {
      role: 'viewer',
    })).status,
  ).toBe(400)
})

test('a viewer is refused on every mutating route', async () => {
  const group = await createGroup('viewer-owner')
  const tag = await addTag(group, 'viewer-owner', 'Entry')
  const created = await call(base(group, '/players'), 'viewer-owner', 'POST', {
    name: 'Ada',
    skill: 5,
  })
  const player = ((await created.json()) as { players: { id: string }[] }).players[0]!
  const viewer = await invite(group, 'viewer-owner', 'viewer')
  await call(`/api/invites/${viewer.token}/accept`, 'viewer-mina', 'POST')

  const refused = [
    ['POST', base(group, '/players'), { name: 'X', skill: 5 }],
    ['PATCH', base(group, `/players/${player.id}`), { name: 'Changed' }],
    ['DELETE', base(group, `/players/${player.id}`), undefined],
    ['POST', base(group, '/matches'), { label: '', teams: [], winner: 0 }],
    ['PATCH', base(group, '/matches/missing'), { position: 0 }],
    ['DELETE', base(group, '/matches/missing'), undefined],
    ['PUT', base(group, '/settings'), { kFactor: 8 }],
    ['POST', base(group, '/tags'), { label: 'New' }],
    ['PATCH', base(group, `/tags/${tag.id}`), { label: 'New' }],
    ['DELETE', base(group, `/tags/${tag.id}`), undefined],
    ['PATCH', base(group), { name: 'New' }],
    ['POST', base(group, '/invites'), { role: 'editor' }],
    ['DELETE', base(group), undefined],
  ] as const
  for (const [method, path, body] of refused) {
    expect((await call(path, 'viewer-mina', method, body)).status).toBe(403)
  }

  // Reads all work.
  for (const path of [
    base(group),
    base(group, '/players'),
    base(group, '/matches'),
    base(group, '/settings'),
    base(group, '/invites'),
    base(group, '/members'),
    base(group, '/rev'),
    base(group, '/rounds'),
  ]) {
    expect((await call(path, 'viewer-mina')).status).toBe(200)
  }

  // Nor can an editor manage sharing or delete the group.
  const members = (await (await call(base(group, '/members'), 'viewer-owner')).json()) as {
    members: { id: string; role: string }[]
  }
  const mina = members.members.find((member) => member.role === 'viewer')!
  await call(base(group, `/members/${mina.id}`), 'viewer-owner', 'PATCH', {
    role: 'editor',
  })
  expect(
    (await call(base(group, '/invites'), 'viewer-mina', 'POST', { role: 'viewer' })).status,
  ).toBe(403)
  expect((await call(base(group), 'viewer-mina', 'DELETE')).status).toBe(403)
})

test('non-members see nothing, and groups stay isolated from each other', async () => {
  const group = await createGroup('iso-owner')
  await call(base(group, '/players'), 'iso-owner', 'POST', {
    players: [{ name: 'Only here', skill: 5 }],
  })
  expect((await call(base(group), 'iso-stranger')).status).toBe(404)
  expect((await call(base(group, '/players'), 'iso-stranger')).status).toBe(404)
  expect(
    (await call(base(group, '/players'), 'iso-stranger', 'POST', { name: 'X', skill: 5 }))
      .status,
  ).toBe(404)

  const second = await createGroup('iso-owner', 'Second')
  const firstList = (await (await call(base(group, '/players'), 'iso-owner')).json()) as {
    players: unknown[]
  }
  const secondList = (await (await call(base(second, '/players'), 'iso-owner')).json()) as {
    players: unknown[]
  }
  expect(firstList.players).toHaveLength(1)
  expect(secondList.players).toHaveLength(0)

  // A group's K is its own setting.
  expect(
    (await call(base(second, '/settings'), 'iso-owner', 'PUT', { kFactor: 8 })).status,
  ).toBe(200)
  const firstSettings = (await (await call(base(group, '/settings'), 'iso-owner')).json()) as {
    kFactor: number
  }
  expect(firstSettings.kFactor).toBe(32)
})

test('a removed member gets a 404 everywhere while the owner keeps access', async () => {
  const group = await createGroup('cut-owner')
  const seeded = await call(base(group, '/players'), 'cut-owner', 'POST', {
    players: [{ name: 'Ada', skill: 5 }],
  })
  expect(seeded.status).toBe(201)
  const viewer = await invite(group, 'cut-owner', 'viewer')
  expect(
    (await call(`/api/invites/${viewer.token}/accept`, 'cut-member', 'POST')).status,
  ).toBe(200)
  expect((await call(base(group, '/players'), 'cut-member')).status).toBe(200)

  expect(
    (await call(base(group, '/members/cut-member'), 'cut-owner', 'DELETE')).status,
  ).toBe(200)

  // A non-member learns nothing: reads, the live poll and writes are all 404.
  for (const path of [
    base(group),
    base(group, '/players'),
    base(group, '/matches'),
    base(group, '/rev'),
  ])
    expect((await call(path, 'cut-member')).status).toBe(404)
  expect(
    (await call(base(group, '/players'), 'cut-member', 'POST', { name: 'X', skill: 5 }))
      .status,
  ).toBe(404)
  const listed = (await (await call('/api/groups', 'cut-member')).json()) as {
    groups: { id: string }[]
  }
  expect(listed.groups.map((entry) => entry.id)).not.toContain(group.id)

  // The group itself keeps working for the owner.
  expect((await call(base(group), 'cut-owner')).status).toBe(200)
  expect((await call(base(group, '/players'), 'cut-owner')).status).toBe(200)
})

test('tags belong to their group and deleting one strips it from players', async () => {
  const group = await createGroup('tag-owner')
  const sniper = await addTag(group, 'tag-owner', 'Sniper', 'SN')
  const created = await call(base(group, '/players'), 'tag-owner', 'POST', {
    players: [{ name: 'Sam', skill: 7, tags: [sniper.id] }],
  })
  const player = ((await created.json()) as { players: { id: string }[] }).players[0]!

  // The same label in another group is a different tag id.
  const other = await createGroup('tag-owner', 'Other')
  const otherSniper = await addTag(other, 'tag-owner', 'Sniper', 'SN')
  expect(otherSniper.id).not.toBe(sniper.id)
  expect(
    (await call(base(group, `/players/${player.id}`), 'tag-owner', 'PATCH', {
      tags: [otherSniper.id],
    })).status,
  ).toBe(400)

  expect(
    (await call(base(group, `/tags/${sniper.id}`), 'tag-owner', 'DELETE')).status,
  ).toBe(200)
  const after = (await (await call(base(group, '/players'), 'tag-owner')).json()) as {
    players: { tags: string[] }[]
  }
  expect(after.players[0]!.tags).toEqual([])
})

test('sitting out is device-local and raised rounds are read-only', async () => {
  const group = await createGroup('state-owner')
  const created = await call(base(group, '/players'), 'state-owner', 'POST', {
    name: 'Ada',
    skill: 5,
  })
  const player = ((await created.json()) as { players: { id: string }[] }).players[0]!
  expect(
    (await call(base(group, `/players/${player.id}`), 'state-owner', 'PATCH', {
      sittingOut: true,
    })).status,
  ).toBe(400)

  const db = env.DB as unknown as Database
  await db
    .prepare(
      'INSERT INTO rounds (id, owner_sub, group_id, config, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      'old-round',
      'state-owner',
      group.id,
      JSON.stringify({
        version: 2,
        teamCount: 1,
        tolerance: 0,
        spread: 0,
        teams: [],
        benchedIds: [],
      }),
      1,
    )
    .run()
  expect((await call(base(group, '/rounds'), 'state-owner')).status).toBe(200)
  expect(
    (await call(base(group, '/rounds'), 'state-owner', 'POST', { config: {} })).status,
  ).toBe(404)
})

test('a legacy workspace migrates into one group exactly once', async () => {
  const db = env.DB as unknown as Database
  await db
    .prepare(
      `INSERT INTO players (id, owner_sub, name, skill, elo, base_elo, tags, sitting_out, created_at, updated_at)
       VALUES ('legacy-player', 'legacy-user', 'Old Timer', 7, 700, 700, '["sniper","igl"]', 0, 1, 1)`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at)
       VALUES ('legacy-event', 'legacy-user', 0, 'adjust', ?, 2, 2)`,
    )
    .bind(JSON.stringify({ playerId: 'legacy-player', elo: 750, reason: 'legacy' }))
    .run()
  await db
    .prepare(
      `INSERT INTO rating_results (event_id, owner_sub, slot, player_id, name, elo_before, elo_after, delta)
       VALUES ('legacy-event', 'legacy-user', '0', 'legacy-player', 'Old Timer', 700, 750, 50)`,
    )
    .run()
  await db
    .prepare('INSERT INTO log_squashes (owner_sub, removed, squashed_at) VALUES (?, ?, ?)')
    .bind('legacy-user', 42, 3)
    .run()

  const first = (await (await call('/api/groups', 'legacy-user')).json()) as {
    groups: Group[]
  }
  expect(first.groups).toHaveLength(1)
  expect(first.groups[0]!.name).toBe('My roster')
  const group = first.groups[0]!

  const detail = (await (await call(base(group), 'legacy-user')).json()) as {
    group: Group
  }
  expect(detail.group.tags.map((tag) => tag.id).sort()).toEqual(['igl', 'sniper'])

  const players = (await (await call(base(group, '/players'), 'legacy-user')).json()) as {
    players: { name: string; tags: string[] }[]
  }
  expect(players.players[0]).toMatchObject({
    name: 'Old Timer',
    tags: ['sniper', 'igl'],
  })

  const matches = (await (await call(base(group, '/matches'), 'legacy-user')).json()) as {
    events: { id: string; kind: string }[]
    squashed: { removed: number } | null
  }
  expect(matches.events.map((event) => event.id)).toEqual(['legacy-event'])
  expect(matches.squashed?.removed).toBe(42)

  // A second visit must not create another home for the same history.
  const second = (await (await call('/api/groups', 'legacy-user')).json()) as {
    groups: Group[]
  }
  expect(second.groups).toHaveLength(1)
})

test('a group is reachable only through its own encoded URL and health reports the schema', async () => {
  const group = await createGroup('url-owner')
  expect(
    (await call(`/api/groups/${encodeURIComponent(group.id)}`, 'url-owner')).status,
  ).toBe(200)

  const health = await call('/api/health')
  expect(await health.json()).toMatchObject({ ok: true, schema: 'ready' })
})

test('an invite previews the roster and a claim becomes a pending request', async () => {
  const group = await createGroup('claim-owner')
  const created = await call(base(group, '/players'), 'claim-owner', 'POST', {
    name: 'Ada',
    skill: 5,
  })
  const ada = (
    (await created.json()) as { players: { id: string; elo: number }[] }
  ).players[0]!
  const link = await invite(group, 'claim-owner', 'viewer')

  const preview = (await (
    await call(`/api/invites/${link.token}`, 'claim-bo')
  ).json()) as {
    invite: { players: { id: string; name: string; username: string; elo: number }[] }
  }
  expect(preview.invite.players).toEqual([
    { id: ada.id, name: 'Ada', username: '', elo: 500 },
  ])

  const accepted = await call(
    `/api/invites/${link.token}/accept`,
    'claim-bo',
    'POST',
    { claim: { kind: 'create', name: 'Bo', username: 'bo' }, note: 'That is me' },
    env.APP_ORIGIN,
    'bo@example.test',
  )
  expect(accepted.status).toBe(200)
  expect(((await accepted.json()) as { request: unknown }).request).not.toBeNull()

  // Joining happens at once; the roster waits for an editor.
  const joiner = (await (await call(base(group), 'claim-bo')).json()) as {
    group: Group
  }
  expect(joiner.group.role).toBe('viewer')
  const roster = (await (
    await call(base(group, '/players'), 'claim-owner')
  ).json()) as { players: { name: string }[] }
  expect(roster.players.map((player) => player.name)).toEqual(['Ada'])

  const pending = (await (
    await call(base(group, '/player-requests'), 'claim-owner')
  ).json()) as {
    requests: {
      kind: string
      name: string | null
      email: string
      note: string
      isYou: boolean
    }[]
  }
  expect(pending.requests).toHaveLength(1)
  expect(pending.requests[0]).toMatchObject({
    kind: 'create',
    name: 'Bo',
    email: 'bo@example.test',
    note: 'That is me',
    isYou: false,
  })

  // Another member sees nothing; the requester sees only their own.
  const otherLink = await invite(group, 'claim-owner', 'viewer')
  await call(
    `/api/invites/${otherLink.token}/accept`,
    'claim-other',
    'POST',
    undefined,
    env.APP_ORIGIN,
    'other@example.test',
  )
  const other = (await (
    await call(base(group, '/player-requests'), 'claim-other')
  ).json()) as { requests: unknown[] }
  expect(other.requests).toHaveLength(0)
  const mine = (await (
    await call(base(group, '/player-requests'), 'claim-bo')
  ).json()) as { requests: { isYou: boolean }[] }
  expect(mine.requests).toHaveLength(1)
  expect(mine.requests[0]!.isYou).toBe(true)

  // A non-member cannot see the queue at all.
  expect(
    (await call(base(group, '/player-requests'), 'claim-stranger')).status,
  ).toBe(404)
})

test('an approved new player starts at 0 elo with no tags and the proposer email', async () => {
  const group = await createGroup('approve-owner')
  const link = await invite(group, 'approve-owner', 'viewer')
  await call(
    `/api/invites/${link.token}/accept`,
    'approve-new',
    'POST',
    { claim: { kind: 'create', name: 'Nova', username: 'nova' } },
    env.APP_ORIGIN,
    'nova@example.test',
  )

  const pending = (await (
    await call(base(group, '/player-requests'), 'approve-owner')
  ).json()) as { requests: { id: string }[] }
  const id = pending.requests[0]!.id
  expect(
    (await call(base(group, `/player-requests/${id}/approve`), 'approve-new', 'POST'))
      .status,
  ).toBe(403)
  expect(
    (
      await call(
        base(group, `/player-requests/${id}/approve`),
        'approve-owner',
        'POST',
      )
    ).status,
  ).toBe(200)

  const roster = (await (
    await call(base(group, '/players'), 'approve-owner')
  ).json()) as {
    players: {
      name: string
      username: string
      elo: number
      tags: string[]
      emails: string[]
    }[]
  }
  expect(roster.players).toHaveLength(1)
  expect(roster.players[0]).toMatchObject({
    name: 'Nova',
    username: 'nova',
    elo: 0,
    tags: [],
    emails: ['nova@example.test'],
  })
  const after = (await (
    await call(base(group, '/player-requests'), 'approve-owner')
  ).json()) as { requests: unknown[] }
  expect(after.requests).toHaveLength(0)

  // A handled request is gone, so approving it again cannot duplicate the player.
  expect(
    (
      await call(
        base(group, `/player-requests/${id}/approve`),
        'approve-owner',
        'POST',
      )
    ).status,
  ).toBe(404)

  // Nobody can slip an elo into a request, and a new player needs both details.
  const sneak = await call(
    `/api/invites/${link.token}/accept`,
    'approve-sneak',
    'POST',
    {
      claim: { kind: 'create', name: 'Sneak', username: 'sneak', elo: 900 },
    },
    env.APP_ORIGIN,
    'sneak@example.test',
  )
  expect(sneak.status).toBe(400)
  expect(
    (await call(base(group), 'approve-sneak')).status,
  ).toBe(404)
  const nameless = await call(
    `/api/invites/${link.token}/accept`,
    'approve-nameless',
    'POST',
    { claim: { kind: 'create', name: 'No Handle' } },
    env.APP_ORIGIN,
    'nameless@example.test',
  )
  expect(nameless.status).toBe(400)
})

test('approving a link claim attaches the email and changes no rating', async () => {
  const group = await createGroup('link-owner')
  const created = await call(base(group, '/players'), 'link-owner', 'POST', {
    name: 'Ada',
    skill: 7,
  })
  const ada = (
    (await created.json()) as { players: { id: string; elo: number }[] }
  ).players[0]!
  const link = await invite(group, 'link-owner', 'viewer')
  await call(
    `/api/invites/${link.token}/accept`,
    'link-member',
    'POST',
    { claim: { kind: 'link', playerId: ada.id }, note: 'Ada here' },
    env.APP_ORIGIN,
    'ada@example.test',
  )

  const request = (
    (await (
      await call(base(group, '/player-requests'), 'link-owner')
    ).json()) as {
      requests: { id: string; kind: string; playerName: string | null }[]
    }
  ).requests[0]!
  expect(request.kind).toBe('link')
  expect(request.playerName).toBe('Ada')
  expect(
    (
      await call(
        base(group, `/player-requests/${request.id}/approve`),
        'link-owner',
        'POST',
      )
    ).status,
  ).toBe(200)

  const roster = (await (
    await call(base(group, '/players'), 'link-owner')
  ).json()) as { players: { elo: number; emails: string[] }[] }
  expect(roster.players[0]).toMatchObject({
    elo: ada.elo,
    emails: ['ada@example.test'],
  })
})

test('emails are editor-managed, several per player, and viewers can only ask', async () => {
  const group = await createGroup('email-owner')
  const created = await call(base(group, '/players'), 'email-owner', 'POST', {
    name: 'Ada',
    skill: 5,
  })
  const ada = (
    (await created.json()) as { players: { id: string }[] }
  ).players[0]!
  const second = await call(base(group, '/players'), 'email-owner', 'POST', {
    name: 'Bea',
    skill: 5,
  })
  const bea = (
    (await second.json()) as { players: { id: string }[] }
  ).players[0]!

  const link = await invite(group, 'email-owner', 'viewer')
  await call(
    `/api/invites/${link.token}/accept`,
    'email-viewer',
    'POST',
    undefined,
    env.APP_ORIGIN,
    'viewer@example.test',
  )

  // A viewer may file their own request, one at a time, but not approve it.
  const filed = await call(
    base(group, '/player-requests'),
    'email-viewer',
    'POST',
    { claim: { kind: 'link', playerId: ada.id }, note: 'me' },
    env.APP_ORIGIN,
    'viewer@example.test',
  )
  expect(filed.status).toBe(201)
  const requestId = ((await filed.json()) as { request: { id: string } }).request.id
  expect(
    (
      await call(
        base(group, '/player-requests'),
        'email-viewer',
        'POST',
        { claim: { kind: 'link', playerId: ada.id } },
        env.APP_ORIGIN,
        'viewer@example.test',
      )
    ).status,
  ).toBe(409)
  expect(
    (
      await call(
        base(group, `/player-requests/${requestId}/approve`),
        'email-viewer',
        'POST',
      )
    ).status,
  ).toBe(403)

  // Emails are editorial.
  expect(
    (
      await call(
        base(group, `/players/${ada.id}/emails`),
        'email-viewer',
        'POST',
        { email: 'a@example.test' },
      )
    ).status,
  ).toBe(403)
  const connected = await call(
    base(group, `/players/${ada.id}/emails`),
    'email-owner',
    'POST',
    { email: 'A@Example.test' },
  )
  expect(connected.status).toBe(201)
  expect(((await connected.json()) as { emails: string[] }).emails).toEqual([
    'a@example.test',
  ])
  expect(
    (
      await call(
        base(group, `/players/${ada.id}/emails`),
        'email-owner',
        'POST',
        { email: 'alt@example.test' },
      )
    ).status,
  ).toBe(201)
  // One email may sit on a second player too.
  expect(
    (
      await call(
        base(group, `/players/${bea.id}/emails`),
        'email-owner',
        'POST',
        { email: 'a@example.test' },
      )
    ).status,
  ).toBe(201)

  const roster = (await (
    await call(base(group, '/players'), 'email-owner')
  ).json()) as { players: { id: string; emails: string[] }[] }
  expect(roster.players.find((player) => player.id === ada.id)?.emails).toEqual([
    'a@example.test',
    'alt@example.test',
  ])
  expect(roster.players.find((player) => player.id === bea.id)?.emails).toEqual([
    'a@example.test',
  ])

  // Disconnecting frees the address.
  expect(
    (
      await call(
        base(group, `/players/${ada.id}/emails/${encodeURIComponent('alt@example.test')}`),
        'email-owner',
        'DELETE',
      )
    ).status,
  ).toBe(200)
  const trimmed = (await (
    await call(base(group, '/players'), 'email-owner')
  ).json()) as { players: { id: string; emails: string[] }[] }
  expect(trimmed.players.find((player) => player.id === ada.id)?.emails).toEqual([
    'a@example.test',
  ])

  // The requester can withdraw, then ask again.
  expect(
    (
      await call(
        base(group, `/player-requests/${requestId}`),
        'email-viewer',
        'DELETE',
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await call(
        base(group, '/player-requests'),
        'email-viewer',
        'POST',
        { claim: { kind: 'create', name: 'Vic', username: 'vic' } },
        env.APP_ORIGIN,
        'viewer@example.test',
      )
    ).status,
  ).toBe(201)
})

test('archiving a player drops its emails and refuses later claims', async () => {
  const group = await createGroup('archive-owner')
  const created = await call(base(group, '/players'), 'archive-owner', 'POST', {
    name: 'Ada',
    skill: 5,
  })
  const ada = (
    (await created.json()) as { players: { id: string }[] }
  ).players[0]!
  const link = await invite(group, 'archive-owner', 'viewer')
  await call(
    `/api/invites/${link.token}/accept`,
    'archive-member',
    'POST',
    undefined,
    env.APP_ORIGIN,
    'arch@example.test',
  )
  expect(
    (
      await call(
        base(group, `/players/${ada.id}/emails`),
        'archive-owner',
        'POST',
        { email: 'arch@example.test' },
      )
    ).status,
  ).toBe(201)
  expect(
    (await call(base(group, `/players/${ada.id}`), 'archive-owner', 'DELETE'))
      .status,
  ).toBe(200)

  const links = await (env.DB as unknown as Database)
    .prepare(
      'SELECT email FROM group_player_emails WHERE group_id = ? AND player_id = ?',
    )
    .bind(group.id, ada.id)
    .all<{ email: string }>()
  expect(links.results).toHaveLength(0)

  expect(
    (
      await call(
        base(group, '/player-requests'),
        'archive-member',
        'POST',
        { claim: { kind: 'link', playerId: ada.id } },
        env.APP_ORIGIN,
        'arch@example.test',
      )
    ).status,
  ).toBe(404)
})

test('every refusal is private and carries no-store', async () => {
  const response = await call('/api/groups/missing/players', 'nobody')
  expect(response.status).toBe(404)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const crossOrigin = await call('/api/groups', 'nobody', 'POST', { name: 'x' }, 'https://evil.example')
  expect(crossOrigin.status).toBe(403)
})
