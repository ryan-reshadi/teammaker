import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { Miniflare } from 'miniflare'
import type { RivalsScan } from '../src/shared/rivals'
import type { Env } from '../src/worker/auth'
import type { createApp as createAppFactory } from '../src/worker/app'

/**
 * The browser half of the screenshot importer, exercised for real.
 *
 * `App` (the component the real entry mounts) is rendered into a DOM, the real
 * `store.scanRivals` uploads a File, the real review helpers run, and the real
 * `RivalsImport` submits through the actual Hono app in this process. Only the
 * OCR service is stubbed, and nothing in the client path is mocked: a drifted
 * multipart field name, a wrong method, a changed scan response shape or a
 * broken same-origin request fails this suite.
 */

const ORIGIN = 'http://app.test'

// ── DOM before React loads ────────────────────────────────────────────────

const win = new Window({ url: `${ORIGIN}/` })
Object.assign(
  globalThis,
  {
    window: win,
    document: win.document,
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

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { createApp } = await import('../src/worker/app')
const { App } = await import('../src/client/App')

// ── The real Worker app, with only the OCR provider stubbed ───────────────

const cleanScan: RivalsScan = {
  version: 1,
  image: { width: 1280, height: 720 },
  teams: [
    { slot: 0, color: 'gold', score: 5, confidence: 0.94 },
    { slot: 1, color: 'purple', score: 3, confidence: 0.94 },
  ],
  winnerSlot: 0,
  rows: [
    {
      index: 0,
      teamSlot: 0,
      color: 'gold',
      username: 'sniperking',
      usernameConfidence: 0.98,
      damage: 12000,
      damageConfidence: 0.95,
      rawDamageText: '12,000',
      issues: [],
    },
    {
      index: 1,
      teamSlot: 0,
      color: 'gold',
      username: 'ZeroHero',
      usernameConfidence: 0.97,
      damage: 0,
      damageConfidence: 0.94,
      rawDamageText: '0',
      issues: [],
    },
    {
      index: 2,
      teamSlot: 1,
      color: 'purple',
      username: 'purplepal',
      usernameConfidence: 0.96,
      damage: 4300,
      damageConfidence: 0.93,
      rawDamageText: '4,300',
      issues: [],
    },
  ],
  issues: [],
}

const issueScan: RivalsScan = {
  version: 1,
  image: { width: 1280, height: 720 },
  teams: [
    { slot: 0, color: 'gold', score: 5, confidence: 0.9 },
    { slot: 1, color: 'purple', score: 3, confidence: 0.9 },
  ],
  winnerSlot: 0,
  rows: [
    cleanScan.rows[0]!,
    {
      index: 1,
      teamSlot: 1,
      color: 'purple',
      username: 'purplepal',
      usernameConfidence: 0.4,
      damage: null,
      damageConfidence: 0,
      rawDamageText: null,
      issues: [
        {
          code: 'damage_unreadable',
          message: 'Damage could not be read — enter it by hand.',
          rowIndex: 1,
          field: 'damage',
        },
      ],
    },
  ],
  issues: [],
}

type OcrMode = 'ok' | 'issues' | 'unreachable'
let ocrMode: OcrMode = 'ok'
const ocrCalls: { url: string; init?: RequestInit }[] = []

const fetchOcr = (async (input: RequestInfo | URL, init?: RequestInit) => {
  ocrCalls.push({ url: String(input), init })
  if (ocrMode === 'unreachable') throw new Error('ECONNREFUSED 127.0.0.1:8000')
  return Response.json(ocrMode === 'issues' ? issueScan : cleanScan)
}) as unknown as typeof fetch

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'browser-rivals',
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
        env: { DB: { type: 'd1', name: 'teammaker-browser-rivals' } },
      },
    },
  ],
  port: 0,
})

let env: Env = {}
let app: ReturnType<typeof createAppFactory>

const originalFetch = globalThis.fetch
type ScanRequest = { method: string; contentType: string; fields: string[] }
const scanRequests: ScanRequest[] = []

/**
 * Stands in for the browser's network layer: relative URLs resolve against the
 * page origin and, exactly like a browser, a non-GET request carries an Origin
 * header. Everything beyond that goes to the real Worker handler.
 */
function installFetchShim() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== 'string' && !(input instanceof URL))
      throw new Error(
        'Browser test: the client sent a Request object; expected a URL and init.',
      )
    const url = new URL(String(input), ORIGIN)
    const request = new Request(url, init)
    const headers = new Headers(request.headers)
    headers.set('Sec-Fetch-Site', 'same-origin')
    if (!headers.has('Origin') && request.method !== 'GET')
      headers.set('Origin', ORIGIN)
    const forwarded = new Request(request, { headers })
    if (url.pathname === '/api/rivals/scan') {
      // Read a clone so the Worker still receives the untouched body. This is
      // what fails loudly if the multipart field name ever drifts.
      const form = await forwarded.clone().formData()
      scanRequests.push({
        method: forwarded.method,
        contentType: headers.get('content-type') ?? '',
        fields: [...form.keys()],
      })
    }
    return app.fetch(forwarded, env)
  }) as typeof fetch
}

// ── DOM helpers ───────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? ''

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => (entry.textContent ?? '').trim() === label,
  )
  if (!found) throw new Error(`No button “${label}” — body: ${text().slice(0, 400)}`)
  return found as HTMLButtonElement
}

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true }) as unknown as Event,
    )
  })
}

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

const pngBytes = (): Uint8Array => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

const upload = async (name = 'scoreboard.png') => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('No file input is rendered.')
  const file = new File([pngBytes() as unknown as BlobPart], name, {
    type: 'image/png',
  })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event)
  })
}

const openImport = async () => {
  if (!document.querySelector('.rivals-drop')) {
    await click(button('Import from RIVALS Screenshot'))
    await waitFor(() => Boolean(document.querySelector('.rivals-drop')), 'import drop zone')
  }
}

const rootHost = win.document.createElement('div')
win.document.body.append(rootHost)
const root = createRoot(rootHost as unknown as HTMLElement)

beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: ORIGIN,
    OCR_SERVICE_URL: 'http://ocr.test:8000',
    OCR_SERVICE_TOKEN: 'ocr-test-token',
  }
  app = createApp(async () => ({ sub: 'browser-test' }), { fetchOcr })

  const seeded = await app.request(
    `${ORIGIN}/api/players`,
    {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        players: [
          { name: 'Sniper King', username: 'sniperking', skill: 7 },
          { name: 'Zero Hero', username: 'ZeroHero', skill: 5 },
          { name: 'Purple Pal', username: 'purplepal', skill: 5 },
        ],
      }),
    },
    env,
  )
  expect(seeded.status).toBe(201)

  installFetchShim()
  await act(async () => {
    root.render(React.createElement(App))
  })
  await waitFor(() => text().includes('Sniper King'), 'the loaded roster')
}, 30_000)

afterAll(async () => {
  await act(async () => {
    root.unmount()
  })
  globalThis.fetch = originalFetch
  await runtime.dispose()
  win.close()
})

// ── Tests ─────────────────────────────────────────────────────────────────

test('the Matches screen switches between manual entry and screenshot import', async () => {
  expect(text()).toContain('Matches')
  expect(document.querySelector('input[aria-label="Match label"]')).not.toBeNull()

  await click(button('Import from RIVALS Screenshot'))
  await waitFor(
    () => text().includes('Upload a screenshot of the in-game Tab scoreboard'),
    'the import drop zone',
  )

  await click(button('Log manually'))
  await waitFor(
    () => Boolean(document.querySelector('input[placeholder^="Label (optional)"]')),
    'the manual match form',
  )
  expect(document.querySelector('.rivals-drop')).toBeNull()
})

test('an unreachable OCR service is shown as a visible error, not a silent no-op', async () => {
  await openImport()
  ocrMode = 'unreachable'
  await upload()
  await waitFor(
    () => text().includes('The screenshot service could not be reached'),
    'the unreachable-service error',
  )
  // The flow returns to the upload screen, ready to retry.
  expect(document.querySelector('.rivals-drop')).not.toBeNull()
  expect(document.querySelector('.rivals-summary')).toBeNull()
})

test('extraction issues are visible and block submission', async () => {
  await openImport()
  ocrMode = 'issues'
  await upload()
  await waitFor(
    () => text().includes('Damage could not be read'),
    'the extraction issue message',
  )
  expect(button('Log match').disabled).toBe(true)
  expect(text()).toContain('Enter whole-number damage for Purple Pal')

  await click(button('Reject screenshot'))
  await waitFor(() => Boolean(document.querySelector('.rivals-drop')), 'the upload screen')
})

test('upload → scan → review → submit creates a replayed match and refreshes the log', async () => {
  await openImport()
  ocrMode = 'ok'
  scanRequests.length = 0
  ocrCalls.length = 0
  await upload()

  await waitFor(() => text().includes('Matched'), 'the review with matched rows')
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Damage for sniperking"]')?.value).toBe('12000')
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Damage for ZeroHero"]')?.value).toBe('0')
  expect(text()).toContain('Gold')
  expect(text()).toContain('Purple')
  expect(document.querySelector<HTMLInputElement>('input[name="rivals-winner"]')?.checked).toBe(true)
  expect(button('Log match').disabled).toBe(false)

  // The client really uploaded a multipart image field.
  const uploadRequest = scanRequests.at(-1)
  expect(uploadRequest?.method).toBe('POST')
  expect(uploadRequest?.fields).toEqual(['image'])
  expect(uploadRequest?.contentType.startsWith('multipart/form-data')).toBe(true)

  // The Worker really called the OCR service with its bearer token.
  const ocrCall = ocrCalls.at(-1)
  expect(ocrCall?.url).toBe('http://ocr.test:8000/scan')
  const ocrHeaders = ocrCall?.init?.headers as Record<string, string>
  expect(ocrHeaders.Authorization).toBe('Bearer ocr-test-token')
  expect(ocrHeaders['Content-Type']).toBe('image/png')

  await click(button('Log match'))
  await waitFor(
    () => text().includes('Match logged') && text().includes('RIVALS Screenshot Import'),
    'the logged match in the refresh-ed log',
  )
  expect(text()).toContain('Team 1 won')

  const log = (await (
    await app.request(`${ORIGIN}/api/matches`, { headers: { Origin: ORIGIN } }, env)
  ).json()) as { events: { label: string; winner: number }[] }
  expect(log.events).toHaveLength(1)
  expect(log.events[0]?.label).toBe('RIVALS Screenshot Import')
  expect(log.events[0]?.winner).toBe(0)

  // Stored outcomes come from the replay, not from the client payload.
  const events = await env.DB!.prepare(
    'SELECT payload FROM rating_events ORDER BY position ASC',
  ).all<{ payload: string }>()
  const payload = JSON.parse(events.results[0]!.payload) as Record<string, unknown>
  expect(Object.keys(payload).sort()).toEqual(['formula', 'k', 'label', 'teams', 'winner'])
  expect(payload.formula).toBe(2)

  const results = await env.DB!.prepare(
    'SELECT COUNT(*) AS total FROM rating_results',
  ).first<{ total: number }>()
  expect(results?.total).toBe(3)

  const elo = await env.DB!.prepare(
    "SELECT elo FROM players WHERE username = 'sniperking'",
  ).first<{ elo: number }>()
  expect(elo?.elo).not.toBe(700)
  expect(elo?.elo).toBeGreaterThan(700)
}, 30_000)
