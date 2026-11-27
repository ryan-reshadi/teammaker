import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import type { MiddlewareHandler } from 'hono'
import { appOrigin, type Env } from './auth'
import { ensureSchema, type Database } from './db'

export type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: Database }
}

export type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

/**
 * Every data route needs a signed-in user, a same-origin mutation and a
 * database. The screenshot route mounts its own copy of this guard ahead of the
 * 64 KB JSON body limit so uploads can be larger without loosening it.
 */
export function sessionGuard(
  authenticate: Authenticate,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  }
}
