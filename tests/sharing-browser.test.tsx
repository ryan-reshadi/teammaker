import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { Miniflare } from 'miniflare'
import type { RivalsScan } from '../src/shared/rivals'
import type { Env } from '../src/worker/auth'
import type { createApp as createAppFactory } from '../src/worker/app'

/**
 * Membership removal while a tab is open.
 *
 * The server half is the group guard: a removed member's next request is a 404
 * and their group list is empty. The browser half is the live poll: when it
 * sees that 404, the open tab must stop showing the roster and rating log it no
 * longer has access to. Only the OCR engine is stubbed; the Worker, D1, the
 * fetch shim and `App` are the real ones.
 */

const ORIGIN = 'http://sharing.test'
const OWNER = 'sharing-owner'
const MEMBER = 'sharing-member'

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

// The poll only runs while the page is visible; happy-dom has no real window.
Object.defineProperty(win.document, 'visibilityState', {
  configurable: true,
  get: () => 'visible',
})

// App imports the OCR entry point, which pulls in WASM that cannot load here.
// The scan itself is not part of this test.
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

// ── The real Worker and D1, with a switchable signed-in identity ──────────

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'sharing-browser',
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
        env: { DB: { type: 'd1', name: 'teammaker-sharing-browser' } },
      },
    },
  ],
  port: 0,
})

let env: Env = {}
let app: ReturnType<typeof createAppFactory>
let currentUser = OWNER as string
let groupId = ''

const originalFetch = globalThis.fetch

/** Relative URLs resolve against the page origin, as they do in a browser. */
function installFetchShim() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN)
    const request = new Request(url, init)
    const headers = new Headers(request.headers)
    headers.set('Sec-Fetch-Site', 'same-origin')
    if (!headers.has('Origin') && request.method !== 'GET')
      headers.set('Origin', ORIGIN)
    return await app.fetch(new Request(request, { headers }), env)
  }) as typeof fetch
}

const asOwner = async <T,>(run: () => Promise<T>): Promise<T> => {
  const previous = currentUser
  currentUser = OWNER
  try {
    return await run()
  } finally {
    currentUser = previous
  }
}

const request = async (path: string, method = 'GET', body?: unknown) =>
  await app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // Mutations need an Origin; the shim adds one for the client.
        ...(method === 'GET' ? {} : { Origin: ORIGIN }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )

// ── DOM helpers ───────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? ''

const waitFor = async (check: () => boolean, label: string, timeout = 8000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  throw new Error(`Timed out waiting for ${label}. Body: ${text().slice(0, 800)}`)
}

const rootHost = win.document.createElement('div')
win.document.body.append(rootHost)
const root = createRoot(rootHost as unknown as HTMLElement)

beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = { DB: db as unknown as D1Database, APP_ORIGIN: ORIGIN }
  app = createApp(async () => ({ sub: currentUser, name: currentUser }))
  installFetchShim()
  win.localStorage.clear()

  const created = await request('/api/groups', 'POST', { name: 'Sharing test' })
  expect(created.status).toBe(201)
  groupId = ((await created.json()) as { group: { id: string } }).group.id

  const seeded = await request(`/api/groups/${groupId}/players`, 'POST', {
    players: [
      { name: 'Ada', skill: 7 },
      { name: 'Grace', skill: 5 },
    ],
  })
  expect(seeded.status).toBe(201)

  const invited = await request(`/api/groups/${groupId}/invites`, 'POST', {
    role: 'viewer',
  })
  expect(invited.status).toBe(201)
  const token = (
    (await invited.json()) as { invite: { url: string } }
  ).invite.url.split('/').pop()!
  currentUser = MEMBER
  expect((await request(`/api/invites/${token}/accept`, 'POST')).status).toBe(200)

  await act(async () => {
    root.render(React.createElement(App))
  })
  await waitFor(() => text().includes('Ada'), 'the shared roster')
}, 30_000)

afterAll(async () => {
  await act(async () => {
    root.unmount()
  })
  globalThis.fetch = originalFetch
  await runtime.dispose()
  win.close()
})

test('a removed member loses the API and their open tab drops the shared roster', async () => {
  expect(text()).toContain('Ada')
  expect(text()).toContain('Grace')
  expect(text()).toContain('View only')

  // While they are a member, every read works.
  for (const path of [`/api/groups/${groupId}`, `/api/groups/${groupId}/players`, `/api/groups/${groupId}/rev`]) {
    expect((await request(path)).status).toBe(200)
  }

  // The owner removes them. From here on the guard answers 404, not 403:
  // a non-member must not learn the group exists.
  const removed = await asOwner(() =>
    request(`/api/groups/${groupId}/members/${MEMBER}`, 'DELETE'),
  )
  expect(removed.status).toBe(200)

  for (const path of [`/api/groups/${groupId}`, `/api/groups/${groupId}/players`, `/api/groups/${groupId}/rev`]) {
    expect((await request(path)).status).toBe(404)
  }
  expect(
    (await request(`/api/groups/${groupId}/players`, 'POST', { name: 'X', skill: 5 }))
      .status,
  ).toBe(404)
  const listed = (await (await request('/api/groups')).json()) as {
    groups: { id: string }[]
  }
  expect(listed.groups.map((group) => group.id)).not.toContain(groupId)

  // The open tab finds out on its next poll (a focus tick here, rather than
  // waiting out the 2.5s interval) and drops everything that was shared.
  await act(async () => {
    win.dispatchEvent(new win.Event('focus'))
  })
  await waitFor(
    () => text().includes('You no longer have access to this group.'),
    'the access message',
  )
  expect(text()).not.toContain('Ada')
  expect(text()).not.toContain('Grace')
  expect(text()).not.toContain('View only')
}, 20_000)
