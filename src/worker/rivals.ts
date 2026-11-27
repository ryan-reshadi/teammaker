import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  RIVALS_ACCEPTED_TYPES,
  RIVALS_MAX_BYTES,
  readRivalsScan,
  sniffImageType,
} from '../shared/rivals'
import type { AppContext, Authenticate } from './guard'
import { sessionGuard } from './guard'

/** The OCR call is bounded so a hung service cannot hold a request open. */
const OCR_TIMEOUT_MS = 25_000

const MAX_LABEL = Math.round(RIVALS_MAX_BYTES / (1024 * 1024))

export type RivalsOptions = {
  authenticate: Authenticate
  /** Tests inject a fake; production uses the platform fetch. */
  fetchOcr?: typeof fetch
}

const configured = (env: AppContext['Bindings']): boolean =>
  Boolean(env.OCR_SERVICE_URL?.trim() && env.OCR_SERVICE_TOKEN?.trim())

const serviceUrl = (base: string): URL | null => {
  try {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/scan`
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return null
  }
}

/**
 * Screenshot import. This router is mounted ahead of the JSON body limit and
 * brings its own session guard, so the upload path can accept 8 MB images
 * without widening what every other route accepts. The OCR service credential
 * never leaves the Worker.
 */
export function createRivalsRoutes({
  authenticate,
  fetchOcr = fetch,
}: RivalsOptions) {
  const app = new Hono<AppContext>()
  const guard = sessionGuard(authenticate)

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use('*', guard)
  app.use(
    '*',
    bodyLimit({
      maxSize: RIVALS_MAX_BYTES,
      onError: (c) =>
        c.json({ error: `Screenshots are up to ${MAX_LABEL} MB.` }, 413),
    }),
  )

  app.get('/config', (c) =>
    c.json({
      configured: configured(c.env),
      maxBytes: RIVALS_MAX_BYTES,
      acceptedTypes: [...RIVALS_ACCEPTED_TYPES],
    }),
  )

  app.post('/scan', async (c) => {
    const url = c.env.OCR_SERVICE_URL?.trim()
    const token = c.env.OCR_SERVICE_TOKEN?.trim()
    if (!url || !token)
      return c.json(
        {
          error:
            'Screenshot import is not configured on this deployment. An OCR service URL and token are required.',
        },
        503,
      )
    const target = serviceUrl(url)
    if (!target)
      return c.json({ error: 'Screenshot import is misconfigured.' }, 503)

    const form = await c.req.formData().catch(() => null)
    if (!form)
      return c.json(
        { error: 'Send the screenshot as a multipart field named image.' },
        400,
      )
    const file = form.get('image')
    if (!file || typeof file === 'string')
      return c.json({ error: 'Send the screenshot as an image file.' }, 400)
    if (file.size === 0)
      return c.json({ error: 'That screenshot is empty.' }, 400)
    if (file.size > RIVALS_MAX_BYTES)
      return c.json({ error: `Screenshots are up to ${MAX_LABEL} MB.` }, 413)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const type = sniffImageType(bytes)
    if (!type)
      return c.json(
        { error: 'Only PNG, JPEG or WebP screenshots are supported.' },
        415,
      )

    let upstream: Response
    try {
      upstream = await fetchOcr(target.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': type,
          Accept: 'application/json',
        },
        body: bytes,
        signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      })
    } catch {
      // The URL and any driver message stay in the Worker logs, not the reply.
      console.error('Teammaker: OCR service unreachable')
      return c.json(
        { error: 'The screenshot service could not be reached. Please try again.' },
        502,
      )
    }

    if (!upstream.ok)
      return c.json(
        {
          error:
            upstream.status === 422
              ? 'That does not look like a RIVALS scoreboard.'
              : 'The screenshot could not be read. Try a clearer image.',
        },
        502,
      )

    const payload: unknown = await upstream.json().catch(() => null)
    const scan = readRivalsScan(payload)
    if (!scan)
      return c.json(
        { error: 'The screenshot service returned an unreadable result.' },
        502,
      )
    return c.json(scan)
  })

  app.notFound((c) => c.json({ error: 'Endpoint not found.' }, 404))
  return app
}
