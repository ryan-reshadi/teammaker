import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'

/**
 * The screenshot route used to carry its own 8 MB limit, mounted ahead of the
 * JSON cap. Scanning happens in the browser now, so the 64 KB cap is the only
 * body limit left — this is what keeps it that way.
 */

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-body-limit',
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
        env: { DB: { type: 'd1', name: 'teammaker-body-limit' } },
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
  }
}, 20_000)
afterAll(() => runtime.dispose())

const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})

test('the 64 KB JSON limit is untouched for every other route', async () => {
  const body = JSON.stringify({ label: 'x'.repeat(70 * 1024) })
  const response = await app.request(
    'https://app.example.test/api/players',
    {
      method: 'POST',
      headers: {
        'test-user': 'alice',
        Origin: env.APP_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body,
    },
    env,
  )
  expect(response.status).toBe(413)
})
