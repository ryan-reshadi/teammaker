import { getRequestListener } from '@hono/node-server'
import { createLibsqlDatabase } from '../src/server/libsql'
import { createApp } from '../src/worker/app'
import { currentUser, getAuth, type Env } from '../src/worker/auth'
import type { Database } from '../src/worker/db'

/**
 * Vercel entrypoint (compiled into the committed `api/index.js` bundle by
 * `bun run build:api`, because Vercel does not bundle relative imports outside
 * `api/` for an ESM project).
 *
 * It runs the same Hono app as the Cloudflare Worker behind `/api/*` and
 * `/auth/freebuff/*` (see vercel.json); Vercel serves the files in dist-client
 * itself, so there is no ASSETS binding here.
 *
 * Environment: APP_ORIGIN, FREEBUFF_CLIENT_ID, FREEBUFF_ISSUER,
 * TURSO_DATABASE_URL, TURSO_AUTH_TOKEN. Without the database URL the app stays
 * in guest mode instead of failing requests.
 */
function connectDatabase(url: string, authToken?: string): Database | undefined {
  try {
    return createLibsqlDatabase(url, authToken)
  } catch (error) {
    // A configured but unreachable database must not look like a missing one:
    // log it, then let the app report its setup state instead of writing nowhere.
    console.error('Teammaker: database connection failed', error)
    return undefined
  }
}

function readEnv(): Env {
  const url = process.env.TURSO_DATABASE_URL
  return {
    DB: url ? connectDatabase(url, process.env.TURSO_AUTH_TOKEN) : undefined,
    FREEBUFF_CLIENT_ID: process.env.FREEBUFF_CLIENT_ID,
    FREEBUFF_ISSUER: process.env.FREEBUFF_ISSUER,
    APP_ORIGIN: process.env.APP_ORIGIN,
  }
}

// One instance per process: the auth SDK caches OIDC discovery on it.
let env: Env | undefined
const environment = (): Env => (env ??= readEnv())

const app = createApp()

async function handler(request: Request): Promise<Response> {
  try {
    const pass = (req: Request) =>
      Promise.resolve(app.fetch(req, environment()))
    const auth = getAuth(environment())
    return await (auth ? auth.wrap(pass)(request) : pass(request))
  } catch (error) {
    // Vercel keeps stderr in the function logs; never log cookies or URLs.
    console.error('Teammaker: request failed', error)
    return Response.json(
      { error: 'Sign-in setup is unavailable. Please try again later.' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
}

export const config = { maxDuration: 30 }

export default getRequestListener(handler)
