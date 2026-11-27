import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'
import type { RivalsScan } from '../src/shared/rivals'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-rivals',
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
        env: { DB: { type: 'd1', name: 'teammaker-rivals-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env = {}
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

const scanPayload: RivalsScan = {
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
      usernameConfidence: 0.96,
      damage: 12000,
      damageConfidence: 0.93,
      rawDamageText: '12,000',
      issues: [],
    },
    {
      index: 1,
      teamSlot: 1,
      color: 'purple',
      username: 'purplepal',
      usernameConfidence: 0.9,
      damage: 4300,
      damageConfidence: 0.9,
      rawDamageText: '4,300',
      issues: [],
    },
  ],
  issues: [],
}

type OcrCall = { url: string; init?: RequestInit }

let calls: OcrCall[] = []
let responder: () => Response = () => Response.json(scanPayload)

const fetchOcr = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), init })
  return responder()
}) as unknown as typeof fetch

const app = createApp(
  async (request) => {
    const sub = request.headers.get('test-user')
    return sub ? { sub } : null
  },
  { fetchOcr },
)

// Built per call: `beforeAll` assigns the database, so the environment must not
// be captured while the module is still loading.
const configured = (): Env => ({
  ...env,
  OCR_SERVICE_URL: 'http://ocr.test:8000',
  OCR_SERVICE_TOKEN: 'service-secret',
})

const pngBytes = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

type CallOptions = {
  user?: string | null
  origin?: string | null
  environment?: Env
  file?: File
}

const scanRequest = ({
  user = 'alice',
  origin = configured().APP_ORIGIN!,
  environment = configured(),
  file = new File([pngBytes()], 'scoreboard.png', { type: 'image/png' }),
}: CallOptions = {}) => {
  const form = new FormData()
  form.append('image', file)
  return app.request(
    'https://app.example.test/api/rivals/scan',
    {
      method: 'POST',
      body: form,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    },
    environment,
  )
}

const jsonRequest = (
  path: string,
  {
    user = 'alice',
    origin = configured().APP_ORIGIN!,
    environment = configured(),
  }: CallOptions = {},
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method: 'GET',
      headers: {
        ...(user ? { 'test-user': user } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    },
    environment,
  )

test('screenshot routes require a session and a same-origin mutation', async () => {
  const signedOut = await jsonRequest('/api/rivals/config', { user: null })
  expect(signedOut.status).toBe(401)
  expect(signedOut.headers.get('Cache-Control')).toBe('private, no-store')

  const foreign = await scanRequest({ origin: 'https://evil.example' })
  expect(foreign.status).toBe(403)
})

test('config reports availability without leaking the service credentials', async () => {
  const response = await jsonRequest('/api/rivals/config')
  expect(response.status).toBe(200)
  const body = (await response.json()) as Record<string, unknown>
  expect(body).toEqual({
    configured: true,
    maxBytes: 8 * 1024 * 1024,
    acceptedTypes: ['image/png', 'image/jpeg', 'image/webp'],
  })
  expect(JSON.stringify(body)).not.toContain('ocr.test')

  const unconfigured = await jsonRequest('/api/rivals/config', { environment: env })
  expect(((await unconfigured.json()) as { configured: boolean }).configured).toBe(false)
})

test('scan is unavailable when the OCR service is not configured', async () => {
  const response = await scanRequest({ environment: env })
  expect(response.status).toBe(503)
  const body = (await response.json()) as { error: string }
  expect(body.error).toContain('not configured')
})

test('scan proxies the image once and returns the validated extraction', async () => {
  calls = []
  responder = () => Response.json(scanPayload)
  const response = await scanRequest()
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = (await response.json()) as RivalsScan
  expect(body.rows[0]?.username).toBe('sniperking')
  expect(body.winnerSlot).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe('http://ocr.test:8000/scan')
  const headers = calls[0]?.init?.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer service-secret')
  expect(headers['Content-Type']).toBe('image/png')
  expect(JSON.stringify(body)).not.toContain('service-secret')
})

test('a 1 MB screenshot passes the upload path that the JSON routes never see', async () => {
  calls = []
  responder = () => Response.json(scanPayload)
  const response = await scanRequest({
    file: new File([pngBytes(1024 * 1024)], 'big.png', { type: 'image/png' }),
  })
  expect(response.status).toBe(200)
  expect(calls).toHaveLength(1)
})

test('a bad upload is rejected before the OCR service is called', async () => {
  calls = []
  const wrongType = await scanRequest({
    file: new File([new TextEncoder().encode('<html>hi</html>')], 'x.png', {
      type: 'image/png',
    }),
  })
  expect(wrongType.status).toBe(415)
  expect(calls).toHaveLength(0)
})

test('uploads are capped at 8 MB', async () => {
  calls = []
  const huge = new File([pngBytes(9 * 1024 * 1024)], 'huge.png', { type: 'image/png' })
  const response = await scanRequest({ file: huge })
  expect(response.status).toBe(413)
  expect(calls).toHaveLength(0)
})

test('the 64 KB JSON limit is untouched for every other route', async () => {
  const body = JSON.stringify({ label: 'x'.repeat(70 * 1024) })
  const response = await app.request(
    'https://app.example.test/api/players',
    {
      method: 'POST',
      headers: {
        'test-user': 'alice',
        Origin: configured().APP_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body,
    },
    configured(),
  )
  expect(response.status).toBe(413)
})

test('upstream failures and unreadable payloads become 502s', async () => {
  responder = () => new Response('nope', { status: 500 })
  const failed = await scanRequest()
  expect(failed.status).toBe(502)

  responder = () => Response.json({ version: 99 })
  const invalid = await scanRequest()
  expect(invalid.status).toBe(502)
})
