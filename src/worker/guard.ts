import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import type { MiddlewareHandler } from 'hono'
import type { GroupRole } from '../shared/types'
import { appOrigin, type Env } from './auth'
import { ensureSchema, type Database } from './db'
import { roleFor } from './groups'

export type AppContext = {
  Bindings: Env
  Variables: {
    user: FreebuffUser
    db: Database
    role: GroupRole
    groupId: string
  }
}

export type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

type Preflight =
  | { ok: true; user: FreebuffUser; db: Database }
  | { ok: false; response: Response }

/** Authentication, same-origin mutations, a bound database and a ready schema. */
async function preflight(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  authenticate: Authenticate,
): Promise<Preflight> {
  const user = await authenticate(c.req.raw, c.env)
  if (!user) return { ok: false, response: c.json({ error: 'Sign in required.' }, 401) }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = appOrigin(c.req.raw, c.env)
    if (!origin || !isSameOriginRequest(c.req.raw, origin))
      return {
        ok: false,
        response: c.json({ error: 'Cross-origin request refused.' }, 403),
      }
  }
  if (!c.env.DB)
    return {
      ok: false,
      response: c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      ),
    }
  await ensureSchema(c.env.DB)
  return { ok: true, user, db: c.env.DB }
}

/**
 * Every data route needs a signed-in user, a same-origin mutation and a
 * database. Routes outside a group (the group list, invites) use this one.
 */
export function sessionGuard(
  authenticate: Authenticate,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const done = await preflight(c, authenticate)
    if (!done.ok) return done.response
    c.set('user', done.user)
    c.set('db', done.db)
    await next()
  }
}

/**
 * The single choke point for group access. Membership comes from the database,
 * never from the request: a non-member sees 404, a viewer cannot write, and
 * sharing (invites and members) plus deleting the group stay owner-only.
 */
export function groupGuard(
  authenticate: Authenticate,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const done = await preflight(c, authenticate)
    if (!done.ok) return done.response
    const groupId = c.req.param('groupId')
    const role = groupId ? await roleFor(done.db, groupId, done.user.sub) : null
    if (!role) return c.json({ error: 'Group not found.' }, 404)

    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
    if (write) {
      const after = c.req.path.replace(/^\/api\/groups\/[^/]+/, '')
      const sharing = after.startsWith('/invites') || after.startsWith('/members')
      const deleting = c.req.method === 'DELETE' && after === ''
      if ((sharing || deleting) && role !== 'owner')
        return c.json({ error: 'Only the group owner can do that.' }, 403)
      if (!sharing && !deleting && role === 'viewer')
        return c.json({ error: 'You have view-only access to this group.' }, 403)
    }

    c.set('user', done.user)
    c.set('db', done.db)
    c.set('role', role)
    c.set('groupId', groupId!)
    await next()
  }
}
