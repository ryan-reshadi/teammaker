import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from 'bun:test'
import { Window } from 'happy-dom'
import { Miniflare } from 'miniflare'
import type { RivalsScan } from '../src/shared/rivals'
import type { Env } from '../src/worker/auth'
import type { createApp as createAppFactory } from '../src/worker/app'

/**
 * Invite-time player connections, exercised through the real components.
 *
 * `App`, `JoinPanel`, `PlayerClaimForm`, `RequestsDialog`, `ConnectDialog` and
 * `Roster` are rendered into a DOM and driven the way a person drives them:
 * typing, choosing, clicking. The real fetch shim sends every request to the
 * real Hono app and Miniflare D1 in this process, so a mis-wired route, a wrong
 * prop or a missing state fails here — not only in the API tests.
 *
 * Only the OCR engine is stubbed: it is ONNX/WASM and cannot start in this DOM,
 * and nothing in this journey scans a screenshot.
 */

const ORIGIN = 'http://connections.test'
const ACTIVE_GROUP_KEY = 'teammaker.activeGroup.v1'

// Each journey mounts the app, joins and reviews; that is more than a default
// five-second budget can hold on a busy machine.
setDefaultTimeout(20_000)

// ── DOM before React loads ────────────────────────────────────────────────

const win = new Window({ url: `${ORIGIN}/` })
Object.assign(
  globalThis,
  {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    navigator: win.navigator,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    SVGElement: win.SVGElement,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  } as unknown as Record<string, unknown>,
)
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

// `App` imports the OCR entry point, which pulls in WASM that cannot load here.
mock.module('../src/client/ocr/index.ts', () => ({
  cancelError: () => new Error('The scan was cancelled.'),
  scanScreenshot: async (): Promise<RivalsScan> => {
    throw new Error('The screenshot scanner is not used in this test.')
  },
}))

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { createApp } = await import('../src/worker/app')
const { App } = await import('../src/client/App')

// ── The real Worker and D1, with a switchable identity ────────────────────

type User = { sub: string; name?: string; email?: string }

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'connections-browser',
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
        env: { DB: { type: 'd1', name: 'teammaker-connections-browser' } },
      },
    },
  ],
  port: 0,
})

let env: Env = {}
let app: ReturnType<typeof createAppFactory>
let currentUser: User | null = null
const originalFetch = globalThis.fetch

/** Every request the rendered components make, for wiring assertions. */
const calls: { method: string; path: string; body: string | null }[] = []

function installFetchShim() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN)
    const request = new Request(url, init)
    calls.push({
      method: request.method,
      path: url.pathname + url.search,
      body: typeof init?.body === 'string' ? init.body : null,
    })
    const headers = new Headers(request.headers)
    headers.set('Sec-Fetch-Site', 'same-origin')
    if (!headers.has('Origin') && request.method !== 'GET')
      headers.set('Origin', ORIGIN)
    return app.fetch(new Request(request, { headers }), env)
  }) as typeof fetch
}

const asUser = async (
  user: User | null,
  run: () => Response | Promise<Response>,
): Promise<Response> => {
  const previous = currentUser
  currentUser = user
  try {
    return await run()
  } finally {
    currentUser = previous
  }
}

/**
 * Calls the real Worker as a chosen identity, outside the rendered app. The
 * request runs inside `act` so a reload the mounted app finishes meanwhile is
 * flushed with the assertion that read the server, as a real tab would.
 */
const api = async (
  user: User,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> => {
  const pending = act(async () =>
    asUser(user, () =>
      app.request(
        `${ORIGIN}${path}`,
        {
          method,
          headers: {
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...(method === 'GET' ? {} : { Origin: ORIGIN }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      ),
    ),
  ) as unknown as Promise<Response>
  return await pending
}

const jsonOf = async <T,>(response: Response): Promise<T> =>
  (await response.json()) as T

const OWNER: User = { sub: 'conn-owner', name: 'Owner', email: 'owner@example.test' }

async function newGroup(
  name: string,
  players: { name: string; username?: string; skill: number }[],
): Promise<{ groupId: string; players: { id: string; name: string; elo: number }[] }> {
  const created = await api(OWNER, '/api/groups', 'POST', { name })
  expect(created.status).toBe(201)
  const { group } = await jsonOf<{ group: { id: string } }>(created)
  if (players.length === 0) return { groupId: group.id, players: [] }
  const seeded = await api(OWNER, `/api/groups/${group.id}/players`, 'POST', {
    players,
  })
  expect(seeded.status).toBe(201)
  const { players: roster } = await jsonOf<{
    players: { id: string; name: string; elo: number }[]
  }>(seeded)
  return { groupId: group.id, players: roster }
}

async function inviteToken(groupId: string, role: 'viewer' | 'editor' = 'viewer') {
  const response = await api(OWNER, `/api/groups/${groupId}/invites`, 'POST', {
    role,
  })
  expect(response.status).toBe(201)
  const { invite } = await jsonOf<{ invite: { url: string } }>(response)
  return invite.url.split('/').pop()!
}

/** Joins through the API so the rendered screen can start from a pending state. */
async function apiJoin(token: string, user: User, claim?: unknown) {
  const response = await api(
    user,
    `/api/invites/${token}/accept`,
    'POST',
    claim === undefined ? undefined : { claim, note: 'It is me' },
  )
  expect(response.status).toBe(200)
}

// ── DOM helpers ───────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? ''
const norm = (value: string) => value.replace(/\s+/g, ' ').trim()
const bodyText = () => norm(text())

/**
 * The page re-imports the DOM types while happy-dom brings its own element
 * classes; these shapes are the few pieces a journey actually uses, so the
 * queries below bridge the two typings in one place.
 */
type Field = {
  value: string
  tagName: string
  dispatchEvent(event: unknown): boolean
}
type Clickable = { dispatchEvent(event: unknown): boolean; click?(): void }
type ButtonLike = Clickable & { disabled: boolean }

const q = <T,>(selector: string): T | null =>
  document.querySelector(selector) as unknown as T | null

const qa = (selector: string): Element[] => [
  ...document.querySelectorAll(selector),
]

const waitFor = async (check: () => boolean, label: string, timeout = 8000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  throw new Error(
    `Timed out waiting for ${label}. Body: ${bodyText().slice(0, 800)}`,
  )
}

const waitForText = (needle: string, label = needle) =>
  waitFor(() => bodyText().includes(needle), label)

const findButton = (label: string): ButtonLike => {
  const found = qa('button').find(
    (entry) => norm(entry.textContent ?? '') === label,
  )
  if (!found)
    throw new Error(`No button “${label}” — body: ${bodyText().slice(0, 500)}`)
  return found as unknown as ButtonLike
}

const click = async (element: unknown) => {
  await act(async () => {
    ;(element as Clickable).dispatchEvent(
      new win.MouseEvent('click', { bubbles: true }),
    )
  })
}

/**
 * Typing as the browser delivers it: the prototype value setter (so React's
 * value tracker sees a change) followed by the input and change events.
 */
const typeInto = async (element: Field, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element) as object,
      'value',
    )?.set
    if (setter) setter.call(element, value)
    else element.value = value
    element.dispatchEvent(new win.Event('input', { bubbles: true }))
    element.dispatchEvent(new win.Event('change', { bubbles: true }))
  })
}

const choose = async (select: Field, value: string) => {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new win.Event('change', { bubbles: true }))
  })
}

/** Approves the review row whose text names this email. */
const approveRequest = async (email: string) => {
  const row = qa('.request-list li').find((entry) =>
    (entry.textContent ?? '').includes(email),
  )
  if (!row) throw new Error(`No request row for ${email}`)
  const button = [...row.querySelectorAll('button')].find(
    (entry) => norm(entry.textContent ?? '') === 'Approve',
  )
  if (!button) throw new Error(`No Approve button for ${email}`)
  await click(button)
}

const selectRadio = async (input: Clickable) => {
  await act(async () => {
    // A real click runs the radio's activation behaviour (checked + change),
    // which is what React's onChange listens for.
    input.click?.()
  })
}

const radioByLabel = (label: string): Clickable => {
  const found = qa('input[type="radio"]').find(
    (entry) => norm(entry.closest('label')?.textContent ?? '') === label,
  )
  if (!found) throw new Error(`No radio “${label}”`)
  return found as unknown as Clickable
}

const playerSelect = () =>
  q<Field>('select[aria-label="Your player on the roster"]')

// ── Mounting the real App ─────────────────────────────────────────────────

type Mounted = { root: ReturnType<typeof createRoot>; host: { remove(): void } }
let mounted: Mounted | null = null

const mount = async (path: string, user: User) => {
  currentUser = user
  win.history.replaceState({}, '', path)
  const host = win.document.createElement('div')
  win.document.body.append(host)
  const root = createRoot(host as unknown as HTMLElement)
  await act(async () => {
    root.render(React.createElement(App))
  })
  mounted = { root, host }
  await waitFor(() => !bodyText().includes('Loading…'), 'the session')
}

const unmount = async () => {
  if (!mounted) return
  const { root, host } = mounted
  mounted = null
  await act(async () => {
    root.unmount()
  })
  host.remove()
}

const openGroup = async (groupId: string, user: User) => {
  win.localStorage.setItem(ACTIVE_GROUP_KEY, groupId)
  await mount('/', user)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = { DB: db as unknown as D1Database, APP_ORIGIN: ORIGIN }
  app = createApp(async () => currentUser)
  // A 500 here is a defect in the journey under test, so fail with its real
  // error instead of the friendly JSON the browser would show.
  app.onError((error) => {
    throw error
  })
  installFetchShim()
}, 30_000)

beforeEach(async () => {
  await unmount()
  win.localStorage.clear()
  calls.length = 0
  currentUser = null
})

afterAll(async () => {
  await unmount()
  globalThis.fetch = originalFetch
  await runtime.dispose()
  win.close()
})

// ── The journey ───────────────────────────────────────────────────────────

test('an invite previews the roster and a link claim joins and files a request', async () => {
  const { groupId, players } = await newGroup('Link claim group', [
    { name: 'Ada', skill: 5 },
  ])
  const ada = players[0]!
  const token = await inviteToken(groupId)
  const joiner: User = {
    sub: 'conn-link-joiner',
    name: 'Link Joiner',
    email: 'link@example.test',
  }

  await mount(`/join/${token}`, joiner)
  await waitForText('Join “Link claim group”', 'the invite preview')

  // The token holder can see the roster before joining...
  expect(bodyText()).toContain("I'm already on the roster")
  expect(
    [...document.querySelectorAll('option')].some((entry) =>
      norm(entry.textContent ?? '').includes('500 elo'),
    ),
  ).toBe(true)
  // ...and the account email is attached, not typed.
  expect(document.querySelector('.claim-email')?.textContent).toBe(
    'link@example.test',
  )
  expect(document.querySelector('input[placeholder="you@example.com"]')).toBeNull()
  expect(
    calls.some(
      (entry) =>
        entry.method === 'GET' && entry.path === `/api/invites/${token}`,
    ),
  ).toBe(true)

  const option = qa('option').find((entry) =>
    norm(entry.textContent ?? '').startsWith('Ada'),
  )
  expect(option).toBeDefined()
  await choose(playerSelect()!, option!.getAttribute('value') ?? '')
  await typeInto(q<Field>('textarea.claim-note')!, 'I am Ada')
  await click(findButton('Send request and join'))

  await waitForText(
    'connect to “Ada” is waiting for an editor',
    'the pending claim notice',
  )
  expect(bodyText()).toContain('Ada')
  // The prompt gives way to the pending notice.
  expect(bodyText()).not.toContain('No player is connected to link@example.test')

  // The claim rode along with the accept; no roster change yet.
  const accept = calls.find(
    (entry) =>
      entry.method === 'POST' &&
      entry.path === `/api/invites/${token}/accept`,
  )
  expect(accept).toBeDefined()
  expect(JSON.parse(accept!.body ?? '{}')).toMatchObject({
    claim: { kind: 'link', playerId: ada.id },
    note: 'I am Ada',
  })

  const roster = await jsonOf<{
    players: { name: string; elo: number; emails: string[] }[]
  }>(await api(OWNER, `/api/groups/${groupId}/players`))
  expect(roster.players).toHaveLength(1)
  expect(roster.players[0]).toMatchObject({ name: 'Ada', elo: 500, emails: [] })

  const pending = await jsonOf<{
    requests: {
      kind: string
      email: string
      note: string
      playerName: string | null
      isYou: boolean
    }[]
  }>(await api(OWNER, `/api/groups/${groupId}/player-requests`))
  expect(pending.requests).toHaveLength(1)
  expect(pending.requests[0]).toMatchObject({
    kind: 'link',
    email: 'link@example.test',
    note: 'I am Ada',
    playerName: 'Ada',
  })

  // Membership was granted immediately, at the link's role.
  const groups = await jsonOf<{ groups: { id: string; role: string }[] }>(
    await api(joiner, '/api/groups'),
  )
  expect(groups.groups.find((entry) => entry.id === groupId)?.role).toBe(
    'viewer',
  )
})

test('a new-player claim needs both details, carries no elo, and waits for approval', async () => {
  const { groupId } = await newGroup('Create claim group', [
    { name: 'Ada', skill: 5 },
  ])
  const token = await inviteToken(groupId)
  const joiner: User = {
    sub: 'conn-create-joiner',
    name: 'Create Joiner',
    email: 'create@example.test',
  }

  await mount(`/join/${token}`, joiner)
  await waitForText('Join “Create claim group”', 'the invite preview')
  await selectRadio(radioByLabel("I'm new here"))
  await waitFor(
    () => q<Field>('input[placeholder="Name on the roster"]') !== null,
    'the new-player fields',
  )
  expect(bodyText()).toContain('0 elo with no tags')

  // Neither detail alone is enough to send.
  const submit = findButton('Send request and join')
  expect(submit.disabled).toBe(true)
  await typeInto(
    q<Field>('input[placeholder="Name on the roster"]')!,
    'Nova',
  )
  expect(findButton('Send request and join').disabled).toBe(true)
  await typeInto(q<Field>('input[placeholder="Handle"]')!, 'nova')
  expect(findButton('Send request and join').disabled).toBe(false)
  await click(findButton('Send request and join'))

  await waitForText(
    'add “Nova” is waiting for an editor',
    'the new-player claim notice',
  )
  // Only the existing roster is on screen: the request has not been applied.
  expect(document.querySelectorAll('.player-row')).toHaveLength(1)
  expect(
    [...document.querySelectorAll('.player-row')].some((row) =>
      (row.textContent ?? '').includes('Nova'),
    ),
  ).toBe(false)

  const roster = await jsonOf<{ players: { name: string }[] }>(
    await api(OWNER, `/api/groups/${groupId}/players`),
  )
  expect(roster.players.map((player) => player.name)).toEqual(['Ada'])

  const pending = await jsonOf<{
    requests: {
      kind: string
      name: string | null
      username: string | null
      email: string
    }[]
  }>(await api(OWNER, `/api/groups/${groupId}/player-requests`))
  expect(pending.requests).toHaveLength(1)
  expect(pending.requests[0]).toMatchObject({
    kind: 'create',
    name: 'Nova',
    username: 'nova',
    email: 'create@example.test',
  })
})

test('joining without connecting leaves a prompt that files, blocks approval and cancels', async () => {
  const { groupId, players } = await newGroup('Skip group', [
    { name: 'Ada', skill: 5 },
  ])
  const token = await inviteToken(groupId)
  const skipper: User = {
    sub: 'conn-skipper',
    name: 'Skipper',
    email: 'skip@example.test',
  }

  await mount(`/join/${token}`, skipper)
  await waitForText('Join “Skip group”', 'the invite preview')
  await click(findButton('Continue without connecting'))
  await waitForText(
    'No player is connected to skip@example.test in this group.',
    'the connect prompt',
  )

  // A viewer files requests but has no review surface.
  expect(
    [...document.querySelectorAll('button')].some((entry) =>
      norm(entry.textContent ?? '').startsWith('Requests'),
    ),
  ).toBe(false)

  let requests = await jsonOf<{
    requests: { id: string; email: string }[]
  }>(await api(skipper, `/api/groups/${groupId}/player-requests`))
  expect(requests.requests).toHaveLength(0)

  await click(findButton('Connect a player'))
  await waitForText(
    'Ask an editor to connect your email to the player you play as.',
    'the connect dialog',
  )
  const option = qa('option').find((entry) =>
    norm(entry.textContent ?? '').startsWith('Ada'),
  )
  expect(option).toBeDefined()
  await choose(playerSelect()!, option!.getAttribute('value') ?? '')
  await click(findButton('Send request'))
  await waitForText(
    'Request sent. A group editor will apply it.',
    'the sent state',
  )
  await click(findButton('Done'))
  await waitForText(
    'connect to “Ada” is waiting for an editor',
    'the pending claim notice',
  )
  // Pending claims take the place of the prompt; it returns after cancelling.
  expect(bodyText()).not.toContain(
    'No player is connected to skip@example.test in this group.',
  )

  requests = await jsonOf<{ requests: { id: string; email: string }[] }>(
    await api(skipper, `/api/groups/${groupId}/player-requests`),
  )
  expect(requests.requests).toHaveLength(1)

  // Filing is allowed for a viewer; applying is not, even by hand.
  const own = requests.requests[0]!.id
  expect(
    (
      await api(
        skipper,
        `/api/groups/${groupId}/player-requests/${own}/approve`,
        'POST',
      )
    ).status,
  ).toBe(403)

  // Nor may a viewer dismiss somebody else's claim.
  const other: User = {
    sub: 'conn-other-member',
    name: 'Other Member',
    email: 'other@example.test',
  }
  await apiJoin(await inviteToken(groupId), other, {
    kind: 'link',
    playerId: players[0]!.id,
  })
  const all = await jsonOf<{ requests: { id: string; email: string }[] }>(
    await api(OWNER, `/api/groups/${groupId}/player-requests`),
  )
  const theirs = all.requests.find((entry) => entry.email === 'other@example.test')!
  expect(
    (
      await api(
        skipper,
        `/api/groups/${groupId}/player-requests/${theirs.id}`,
        'DELETE',
      )
    ).status,
  ).toBe(403)

  // The viewer's own claim is still there, and they can withdraw it from the tab.
  expect((await api(skipper, `/api/groups/${groupId}/player-requests`)).status).toBe(
    200,
  )
  await click(findButton('Cancel request'))
  await waitForText(
    'No player is connected to skip@example.test in this group.',
    'the connect prompt after cancelling',
  )
  expect(bodyText()).not.toContain('waiting for an editor')
  requests = await jsonOf<{ requests: { id: string; email: string }[] }>(
    await api(skipper, `/api/groups/${groupId}/player-requests`),
  )
  expect(requests.requests).toHaveLength(0)
})

test('a member without an account email can still ask to be connected, and approval links it', async () => {
  const { groupId, players } = await newGroup('No email group', [
    { name: 'Ada', skill: 5 },
  ])
  const ada = players[0]!
  const token = await inviteToken(groupId)
  const noEmail: User = { sub: 'conn-no-email', name: 'No Email' }

  // The invite page asks this account for an address; there is none to show.
  await mount(`/join/${token}`, noEmail)
  await waitForText('Join “No email group”', 'the invite preview')
  expect(document.querySelector('.claim-email')).toBeNull()
  expect(q<Field>('input[placeholder="you@example.com"]')).not.toBeNull()

  await click(findButton('Continue without connecting'))
  await waitForText(
    'No player is connected to your account yet.',
    'the connect prompt',
  )

  // A supplied address is reachable here, but the server validates it.
  expect(
    (
      await api(noEmail, `/api/groups/${groupId}/player-requests`, 'POST', {
        claim: { kind: 'link', playerId: ada.id },
        email: 'not-an-email',
      })
    ).status,
  ).toBe(400)

  await click(findButton('Connect a player'))
  await waitForText(
    'Ask an editor to connect your email to the player you play as.',
    'the connect dialog',
  )
  // Still no read-only account address in the form.
  expect(document.querySelector('.claim-email')).toBeNull()

  const option = qa('option').find((entry) =>
    norm(entry.textContent ?? '').startsWith('Ada'),
  )
  expect(option).toBeDefined()
  await choose(playerSelect()!, option!.getAttribute('value') ?? '')
  // A player alone is not enough: the request needs an address to link.
  expect(findButton('Send request').disabled).toBe(true)
  await typeInto(
    q<Field>('input[placeholder="you@example.com"]')!,
    'member@example.test',
  )
  expect(findButton('Send request').disabled).toBe(false)
  await click(findButton('Send request'))
  await waitForText(
    'Request sent. A group editor will apply it.',
    'the sent state',
  )

  const filed = calls
    .filter(
      (entry) =>
        entry.method === 'POST' &&
        entry.path === `/api/groups/${groupId}/player-requests`,
    )
    .at(-1)
  expect(filed).toBeDefined()
  expect(JSON.parse(filed!.body ?? '{}')).toMatchObject({
    claim: { kind: 'link', playerId: ada.id },
    email: 'member@example.test',
  })

  await click(findButton('Done'))
  await waitForText(
    'connect to “Ada” is waiting for an editor',
    'the pending claim notice',
  )
  expect(bodyText()).not.toContain('No player is connected to your account yet.')

  const pending = await jsonOf<{
    requests: { id: string; email: string; kind: string }[]
  }>(await api(OWNER, `/api/groups/${groupId}/player-requests`))
  expect(pending.requests).toHaveLength(1)
  expect(pending.requests[0]).toMatchObject({
    kind: 'link',
    email: 'member@example.test',
  })

  // The editor applies it from the review queue, and the email is linked.
  await unmount()
  await openGroup(groupId, OWNER)
  await waitForText('Requests (1)', 'the requests badge')
  await click(findButton('Requests (1)'))
  await waitForText('Connect this email to “Ada”.', 'the review dialog')
  expect(bodyText()).toContain('No Email')
  expect(bodyText()).toContain('member@example.test')
  await click(findButton('Approve'))
  await waitForText('No requests are waiting.', 'the empty queue')
  await click(findButton('Done'))

  const roster = await jsonOf<{
    players: { name: string; email: string[]; emails: string[] }[]
  }>(await api(OWNER, `/api/groups/${groupId}/players`))
  expect(roster.players).toHaveLength(1)
  expect(roster.players[0]!.emails).toEqual(['member@example.test'])

  // Back on the member's device the prompt stays away: this browser remembers
  // the address their request carried.
  await unmount()
  await openGroup(groupId, noEmail)
  await waitForText('Ada', 'the roster')
  expect(bodyText()).not.toContain('No player is connected to your account yet.')
  expect(bodyText()).not.toContain('Connect a player')
})

test('a no-email invite visitor supplies an address for a link claim and a create claim', async () => {
  const { groupId, players } = await newGroup('No email invite group', [
    { name: 'Ada', skill: 5 },
  ])
  const ada = players[0]!
  const token = await inviteToken(groupId)
  const linker: User = { sub: 'conn-join-link-no-email', name: 'Link No Email' }
  const creator: User = { sub: 'conn-join-create-no-email', name: 'Create No Email' }
  const emailField = () => q<Field>('input[placeholder="you@example.com"]')!

  await mount(`/join/${token}`, linker)
  await waitForText('Join “No email invite group”', 'the invite preview')
  // There is no account address to show, so the visitor types one.
  expect(document.querySelector('.claim-email')).toBeNull()
  expect(emailField()).not.toBeNull()

  const option = qa('option').find((entry) =>
    norm(entry.textContent ?? '').startsWith('Ada'),
  )
  expect(option).toBeDefined()
  await choose(playerSelect()!, option!.getAttribute('value') ?? '')

  // A malformed address is named as such and cannot be sent.
  await typeInto(emailField(), 'not-an-email')
  expect(bodyText()).toContain('That does not look like an email address yet.')
  expect(findButton('Send request and join').disabled).toBe(true)

  const rejected = await api(linker, `/api/invites/${token}/accept`, 'POST', {
    claim: { kind: 'link', playerId: ada.id },
    email: 'not-an-email',
  })
  expect(rejected.status).toBe(400)
  expect(await jsonOf<{ error: string }>(rejected)).toMatchObject({
    error: 'That does not look like an email address.',
  })

  // A real one is trimmed and lowercased before it leaves the form.
  await typeInto(emailField(), ' Link.NoEmail@Example.Test ')
  expect(bodyText()).not.toContain('That does not look like an email address yet.')
  expect(findButton('Send request and join').disabled).toBe(false)
  await click(findButton('Send request and join'))
  await waitForText(
    'Your request to connect to “Ada” is waiting for an editor.',
    'the pending link claim',
  )

  const linkAccept = calls
    .filter(
      (entry) =>
        entry.method === 'POST' && entry.path === `/api/invites/${token}/accept`,
    )
    .at(-1)
  expect(linkAccept).toBeDefined()
  expect(JSON.parse(linkAccept!.body ?? '{}')).toMatchObject({
    claim: { kind: 'link', playerId: ada.id },
    email: 'link.noemail@example.test',
  })

  const linkRow = await env
    .DB!.prepare(
      'SELECT email, kind FROM group_player_requests WHERE group_id = ? AND requester_sub = ?',
    )
    .bind(groupId, linker.sub)
    .first<{ email: string; kind: string }>()
  expect(linkRow).toMatchObject({
    email: 'link.noemail@example.test',
    kind: 'link',
  })

  // The same invite, a second account-less visitor proposing a new player.
  await unmount()
  await mount(`/join/${token}`, creator)
  await waitForText('Join “No email invite group”', 'the invite preview again')
  expect(document.querySelector('.claim-email')).toBeNull()

  await selectRadio(radioByLabel("I'm new here"))
  await typeInto(q<Field>('input[placeholder="Name on the roster"]')!, 'Nova')
  await typeInto(q<Field>('input[placeholder="Handle"]')!, 'nova')
  await typeInto(emailField(), ' New.Player@Example.Test ')
  expect(findButton('Send request and join').disabled).toBe(false)
  await click(findButton('Send request and join'))
  await waitForText(
    'Your request to add “Nova” is waiting for an editor.',
    'the pending create claim',
  )

  const createAccept = calls
    .filter(
      (entry) =>
        entry.method === 'POST' && entry.path === `/api/invites/${token}/accept`,
    )
    .at(-1)
  expect(createAccept).toBeDefined()
  expect(JSON.parse(createAccept!.body ?? '{}')).toMatchObject({
    claim: { kind: 'create', name: 'Nova', username: 'nova' },
    email: 'new.player@example.test',
  })

  const pendingRows = await env
    .DB!.prepare(
      'SELECT requester_sub, email, kind FROM group_player_requests WHERE group_id = ?',
    )
    .bind(groupId)
    .all<{ requester_sub: string; email: string; kind: string }>()
  expect(pendingRows.results).toHaveLength(2)
  expect(pendingRows.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requester_sub: linker.sub,
        email: 'link.noemail@example.test',
        kind: 'link',
      }),
      expect.objectContaining({
        requester_sub: creator.sub,
        email: 'new.player@example.test',
        kind: 'create',
      }),
    ]),
  )

  // An editor applies both from the queue.
  await unmount()
  await openGroup(groupId, OWNER)
  await waitForText('Requests (2)', 'the requests badge')
  await click(findButton('Requests (2)'))
  await waitForText('Connect this email to “Ada”.', 'the review dialog')
  expect(bodyText()).toContain('link.noemail@example.test')
  expect(bodyText()).toContain('Add “Nova” (@nova) as a new player at 0 elo.')
  expect(bodyText()).toContain('new.player@example.test')

  await approveRequest('link.noemail@example.test')
  await waitFor(() => qa('.request-list li').length === 1, 'the applied link claim')

  // The link attaches the address to the existing player; nobody is added.
  const linked = await jsonOf<{
    players: { name: string; elo: number; emails: string[] }[]
  }>(await api(OWNER, `/api/groups/${groupId}/players`))
  expect(linked.players).toHaveLength(1)
  expect(linked.players[0]).toMatchObject({
    name: 'Ada',
    elo: 500,
    emails: ['link.noemail@example.test'],
  })

  await approveRequest('new.player@example.test')
  await waitForText('No requests are waiting.', 'the empty queue')
  await click(findButton('Done'))
  await waitFor(
    () => bodyText().includes('new.player@example.test'),
    'the roster email line',
  )

  const roster = await jsonOf<{
    players: { name: string; elo: number; skill: number; tags: string[]; emails: string[] }[]
  }>(await api(OWNER, `/api/groups/${groupId}/players`))
  expect(roster.players).toHaveLength(2)
  expect(roster.players.find((player) => player.name === 'Ada')).toMatchObject({
    elo: 500,
    emails: ['link.noemail@example.test'],
  })
  expect(roster.players.find((player) => player.name === 'Nova')).toMatchObject({
    elo: 0,
    skill: 1,
    tags: [],
    emails: ['new.player@example.test'],
  })

  const nova = await env
    .DB!.prepare(
      'SELECT owner_sub, elo, base_elo, skill FROM players WHERE group_id = ? AND name = ?',
    )
    .bind(groupId, 'Nova')
    .first<{ owner_sub: string; elo: number; base_elo: number; skill: number }>()
  expect(nova).toMatchObject({
    owner_sub: creator.sub,
    elo: 0,
    base_elo: 0,
    skill: 1,
  })
})

test('an editor approves a link claim and the roster shows the connected email', async () => {
  const { groupId, players } = await newGroup('Approve link group', [
    { name: 'Ada', skill: 5 },
  ])
  const token = await inviteToken(groupId)
  const requester: User = {
    sub: 'conn-link-requester',
    name: 'Link Requester',
    email: 'requester@example.test',
  }
  await apiJoin(token, requester, { kind: 'link', playerId: players[0]!.id })

  await openGroup(groupId, OWNER)
  await waitForText('Requests (1)', 'the requests badge')
  await click(findButton('Requests (1)'))
  await waitForText('Player requests', 'the review dialog')
  expect(bodyText()).toContain('Link Requester')
  expect(bodyText()).toContain('requester@example.test')
  expect(bodyText()).toContain('“It is me”')
  expect(bodyText()).toContain('Connect this email to “Ada”.')

  await click(findButton('Approve'))
  await waitForText('No requests are waiting.', 'the empty queue')

  // The roster row behind the dialog now carries the email.
  await waitFor(
    () =>
      (document.querySelector('.player-emails-line')?.textContent ?? '').includes(
        'requester@example.test',
      ),
    'the roster email line',
  )

  const roster = await jsonOf<{
    players: { name: string; elo: number; emails: string[] }[]
  }>(await api(OWNER, `/api/groups/${groupId}/players`))
  expect(roster.players).toHaveLength(1)
  expect(roster.players[0]).toMatchObject({
    name: 'Ada',
    elo: 500,
    emails: ['requester@example.test'],
  })

  await click(findButton('Done'))
  await waitFor(() => !bodyText().includes('Player requests'), 'the closed dialog')
  expect(bodyText()).toContain('requester@example.test')
})

test('an approved new player starts at literal 0 elo with no tags and the proposer as owner', async () => {
  const { groupId } = await newGroup('Approve create group', [
    { name: 'Ada', skill: 5 },
  ])
  const token = await inviteToken(groupId)
  const requester: User = {
    sub: 'conn-create-requester',
    name: 'Nova Requester',
    email: 'nova@example.test',
  }
  await apiJoin(token, requester, {
    kind: 'create',
    name: 'Nova',
    username: 'nova',
  })

  await openGroup(groupId, OWNER)
  await waitForText('Requests (1)', 'the requests badge')
  await click(findButton('Requests (1)'))
  await waitForText(
    'Add “Nova” (@nova) as a new player at 0 elo.',
    'the create request copy',
  )
  await click(findButton('Approve'))
  await waitForText('No requests are waiting.', 'the empty queue')

  await waitFor(
    () => document.querySelector('[aria-label="Advanced elo for Nova: 0"]') !== null,
    'the 0-elo badge',
  )
  expect(document.querySelectorAll('.player-row')).toHaveLength(2)
  expect(
    document.querySelector('[aria-label="Tags for Nova: none yet"]'),
  ).not.toBeNull()
  expect(bodyText()).toContain('nova@example.test')

  const roster = await jsonOf<{
    players: {
      name: string
      elo: number
      skill: number
      tags: string[]
      emails: string[]
    }[]
  }>(await api(OWNER, `/api/groups/${groupId}/players`))
  expect(roster.players.find((player) => player.name === 'Nova')).toMatchObject({
    elo: 0,
    skill: 1,
    tags: [],
    emails: ['nova@example.test'],
  })

  // The requester owns the row and the replay anchor is the same literal 0.
  const row = await env.DB!.prepare(
    'SELECT owner_sub, base_elo, skill FROM players WHERE group_id = ? AND name = ?',
  )
    .bind(groupId, 'Nova')
    .first<{ owner_sub: string; base_elo: number; skill: number }>()
  expect(row).toMatchObject({
    owner_sub: 'conn-create-requester',
    base_elo: 0,
    skill: 1,
  })
})

test('an editor dismisses a request, and a requester cancels their own', async () => {
  const { groupId, players } = await newGroup('Dismiss group', [
    { name: 'Ada', skill: 5 },
  ])
  const ghostToken = await inviteToken(groupId)
  const ghost: User = {
    sub: 'conn-ghost',
    name: 'Ghost Requester',
    email: 'ghost@example.test',
  }
  await apiJoin(ghostToken, ghost, {
    kind: 'create',
    name: 'Ghost',
    username: 'ghost',
  })

  await openGroup(groupId, OWNER)
  await waitForText('Requests (1)', 'the requests badge')
  await click(findButton('Requests (1)'))
  await waitForText('Ghost Requester', 'the request row')
  expect(bodyText()).toContain('Add “Ghost” (@ghost) as a new player at 0 elo.')
  await click(findButton('Dismiss'))
  await waitForText('No requests are waiting.', 'the empty queue')
  expect(bodyText()).not.toContain('Ghost Requester')
  expect(document.querySelector('[aria-label="Advanced elo for Ghost: 0"]')).toBeNull()

  let roster = await jsonOf<{ players: { name: string }[] }>(
    await api(OWNER, `/api/groups/${groupId}/players`),
  )
  expect(roster.players.map((player) => player.name)).toEqual(['Ada'])
  let requests = await jsonOf<{ requests: unknown[] }>(
    await api(OWNER, `/api/groups/${groupId}/player-requests`),
  )
  expect(requests.requests).toHaveLength(0)

  await unmount()

  // A member with a pending claim can withdraw it.
  const canceler: User = {
    sub: 'conn-canceler',
    name: 'Cancel User',
    email: 'cancel@example.test',
  }
  await apiJoin(await inviteToken(groupId), canceler, {
    kind: 'link',
    playerId: players[0]!.id,
  })
  await openGroup(groupId, canceler)
  await waitForText(
    'connect to “Ada” is waiting for an editor',
    'the pending claim notice',
  )
  await click(findButton('Cancel request'))
  await waitForText(
    'No player is connected to cancel@example.test in this group.',
    'the connect prompt after cancelling',
  )
  expect(bodyText()).not.toContain('waiting for an editor')
  requests = await jsonOf<{ requests: unknown[] }>(
    await api(canceler, `/api/groups/${groupId}/player-requests`),
  )
  expect(requests.requests).toHaveLength(0)
})

test('the roster editor connects and disconnects player emails', async () => {
  const { groupId } = await newGroup('Email group', [{ name: 'Ada', skill: 5 }])
  await openGroup(groupId, OWNER)
  await waitForText('Ada', 'the roster')

  await click(document.querySelector('.player-name')!)
  await waitForText('Connected emails', 'the player details editor')
  expect(bodyText()).toContain('No emails connected.')

  await typeInto(
    q<Field>('input[aria-label="Email to connect to Ada"]')!,
    'first@example.test',
  )
  await click(findButton('Connect'))
  await waitFor(
    () => bodyText().includes('first@example.test'),
    'the first email chip',
  )
  expect(
    (
      await jsonOf<{ players: { emails: string[] }[] }>(
        await api(OWNER, `/api/groups/${groupId}/players`),
      )
    ).players[0]!.emails,
  ).toEqual(['first@example.test'])

  // A successful connect clears the field; typing before that lands would be
  // wiped by the clear, so wait for the settled form first.
  await waitFor(() => findButton('Connect').disabled, 'the cleared email field')
  await typeInto(
    q<Field>('input[aria-label="Email to connect to Ada"]')!,
    'second@example.test',
  )
  await waitFor(() => !findButton('Connect').disabled, 'a ready email field')
  await click(findButton('Connect'))
  await waitFor(
    () => bodyText().includes('second@example.test'),
    'the second email chip',
  )

  // Outside the editor the row lists them too.
  await click(findButton('Cancel'))
  await waitFor(
    () =>
      (document.querySelector('.player-emails-line')?.textContent ?? '').includes(
        'second@example.test',
      ),
    'the roster email line',
  )
  expect(norm(document.querySelector('.player-emails-line')?.textContent ?? '')).toBe(
    'first@example.test · second@example.test',
  )

  await click(document.querySelector('.player-name')!)
  await waitForText('Connected emails', 'the editor again')
  await click(
    document.querySelector(
      'button[aria-label="Disconnect first@example.test from Ada"]',
    )!,
  )
  await waitFor(
    () => !bodyText().includes('first@example.test'),
    'the disconnected email',
  )
  expect(
    (
      await jsonOf<{ players: { emails: string[] }[] }>(
        await api(OWNER, `/api/groups/${groupId}/players`),
      )
    ).players[0]!.emails,
  ).toEqual(['second@example.test'])
})
