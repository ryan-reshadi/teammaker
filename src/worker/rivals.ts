import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  RIVALS_ACCEPTED_TYPES,
  RIVALS_MAX_BYTES,
  readRivalsScan,
  sniffImageType,
  type RivalsConfigStatus,
  type RivalsEnvVar,
} from '../shared/rivals'
import type { AppContext, Authenticate } from './guard'
import { sessionGuard } from './guard'

/**
 * The OCR call is bounded so a hung service cannot hold a request open.
 *
 * Vercel caps this function at 30 s (`vercel.json`), so the call has to finish
 * inside that with room for the function's own work. The slowest real capture
 * takes ~24 s while the service is warm — the table pass dominates — and the
 * first scan after a restart is slower still, which is what the old 25 s budget
 * did not allow for. A timeout here is reported as a retryable 502, never as a
 * failed import.
 */
const OCR_TIMEOUT_MS = 28_000
/** A health probe answers a panel; it must not hold the panel open for long. */
const CONFIG_PROBE_TIMEOUT_MS = 2_500

const MAX_LABEL = Math.round(RIVALS_MAX_BYTES / (1024 * 1024))

export type RivalsOptions = {
  authenticate: Authenticate
  /** Tests inject a fake; production uses the platform fetch. */
  fetchOcr?: typeof fetch
}

/** What each variable is for, so the reply can say what to set and why. */
const ENV_HINT: Record<RivalsEnvVar, string> = {
  OCR_SERVICE_URL:
    "OCR_SERVICE_URL (the OCR service's base URL, for example http://127.0.0.1:8000 in development)",
  OCR_SERVICE_TOKEN:
    'OCR_SERVICE_TOKEN (the bearer token the OCR service was started with)',
}

const missingVars = (env: AppContext['Bindings']): RivalsEnvVar[] => {
  const missing: RivalsEnvVar[] = []
  if (!env.OCR_SERVICE_URL?.trim()) missing.push('OCR_SERVICE_URL')
  if (!env.OCR_SERVICE_TOKEN?.trim()) missing.push('OCR_SERVICE_TOKEN')
  return missing
}

const missingMessage = (missing: RivalsEnvVar[]): string =>
  `Screenshot import is not configured: set ${missing
    .map((name) => ENV_HINT[name])
    .join(' and ')}, then redeploy.`

/** An endpoint under the configured base URL; null when the URL is unusable. */
const endpoint = (base: string, leaf: 'scan' | 'health'): URL | null => {
  try {
    const url = new URL(base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${leaf}`
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return null
  }
}

type Probe = {
  status: Exclude<RivalsConfigStatus, 'unconfigured'>
  message: string
  engine?: string
}

const timedOut = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TimeoutError' || error.name === 'AbortError')

/**
 * One real round trip to the service's `/health`. The answer is the difference
 * between "nobody set the variables" and "they are set, but nothing is listening
 * or it is still loading its models" — two problems with different fixes.
 */
async function probeService(base: string, fetchOcr: typeof fetch): Promise<Probe> {
  const target = endpoint(base, 'health')
  if (!target)
    return {
      status: 'invalid_url',
      message:
        'OCR_SERVICE_URL is not a valid http(s) URL, so the OCR service cannot be reached. Fix it, then redeploy.',
    }
  let response: Response
  try {
    response = await fetchOcr(target.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CONFIG_PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    // The driver's message can name the host, so it stays in the Worker logs.
    console.error(
      `Teammaker: OCR health probe ${timedOut(error) ? 'timed out' : 'failed'}`,
      error instanceof Error ? error.message : error,
    )
    return timedOut(error)
      ? {
          status: 'timeout',
          message: `The OCR service did not answer within ${
            CONFIG_PROBE_TIMEOUT_MS / 1000
          } s. It may still be starting (the first load reads its models) or the host is blocking the request — check again in a moment.`,
        }
      : {
          status: 'unreachable',
          message:
            'The OCR service could not be reached. Start it with "bun run ocr:serve" in development, or check that the deployed container is running and publicly reachable, then check again.',
        }
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok)
    return {
      status: 'error',
      message: `The OCR service answered HTTP ${response.status} instead of a health response. It is running but not healthy — check its logs.`,
    }
  if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok === false)
    return {
      status: 'error',
      message:
        'The OCR service answered without a health response. Check that OCR_SERVICE_URL points at the OCR service and not at something else.',
    }
  const engine = (payload as { engine?: unknown }).engine
  return {
    status: 'ready',
    message: 'Screenshot import is ready.',
    ...(typeof engine === 'string' ? { engine: engine.slice(0, 40) } : {}),
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

  const configState = async (env: AppContext['Bindings']) => {
    const missing = missingVars(env)
    if (missing.length > 0)
      return {
        configured: false,
        status: 'unconfigured' as const,
        missing,
        message: missingMessage(missing),
      }
    const probe = await probeService(env.OCR_SERVICE_URL!.trim(), fetchOcr)
    return {
      configured: probe.status === 'ready',
      status: probe.status,
      missing: [] as RivalsEnvVar[],
      message: probe.message,
      ...(probe.engine ? { engine: probe.engine } : {}),
    }
  }

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

  app.get('/config', async (c) =>
    c.json({
      ...(await configState(c.env)),
      maxBytes: RIVALS_MAX_BYTES,
      acceptedTypes: [...RIVALS_ACCEPTED_TYPES],
    }),
  )

  app.post('/scan', async (c) => {
    const url = c.env.OCR_SERVICE_URL?.trim()
    const token = c.env.OCR_SERVICE_TOKEN?.trim()
    if (!url || !token)
      return c.json({ error: missingMessage(missingVars(c.env)) }, 503)
    const target = endpoint(url, 'scan')
    if (!target)
      return c.json(
        {
          error:
            'Screenshot import is misconfigured: OCR_SERVICE_URL is not a valid http(s) URL.',
        },
        503,
      )

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
    } catch (error) {
      // The URL and any driver message stay in the Worker logs, not the reply.
      console.error(
        `Teammaker: OCR service ${
          timedOut(error) ? 'timed out' : 'unreachable'
        }`,
        error instanceof Error ? error.message : error,
      )
      return c.json(
        {
          error: timedOut(error)
            ? 'The screenshot service took too long to answer. It may still be loading its models — try again in a moment.'
            : 'The screenshot service could not be reached. Check that the OCR service is running, then try again.',
        },
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
