/**
 * Stage 0 lab: run the browser pipeline over the six real captures and print
 * the same accuracy table `bun run ocr:captures` prints on the server.
 *
 * Dev-only. It is the gate for the in-browser OCR: a capture must match exactly,
 * because a plausible-but-wrong value is worse than a blank one.
 *
 * The fixtures are real scoreboards with real player names, so they live beside
 * the tests rather than in `public`: `public` is copied into every deployment
 * verbatim, and these images have no business being on one. Vite serves the
 * imports below in development only, and this page is never a build input.
 */

import { decodeScreenshot } from './image'
import { analyzeImage } from './pipeline'
import { BrowserTextReader } from './reader'

type Truth = {
  teams?: { gold?: number; purple?: number }
  winner?: 'gold' | 'purple'
  rows: { username?: string; team?: 'gold' | 'purple'; damage?: number }[]
}

type Capture = { name: string; ms: number; truth: Truth; result: Awaited<ReturnType<typeof analyzeImage>> | null; error?: string }

/** Glob keys are paths; the lab only ever needs the file name. */
const baseName = (path: string) => path.replace(/^.*[/\\]/, '')

// The patterns must stay string literals: Vite parses this call statically.
const SCREENSHOTS = new Map(
  Object.entries(
    import.meta.glob('../../../tests/fixtures/rivals/*.png', {
      query: '?url',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, url]) => [baseName(path), url]),
)

const TRUTHS = new Map(
  Object.entries(
    import.meta.glob('../../../tests/fixtures/rivals/*.truth.json', {
      import: 'default',
      eager: true,
    }) as Record<string, Truth>,
  ).map(([path, truth]) => [baseName(path), truth]),
)

const NAMES = [...TRUTHS.keys()]
  .map((file) => file.replace(/\.truth\.json$/, ''))
  .sort()

const out = document.getElementById('out')!
const status = document.getElementById('status')!
const lines: string[] = []

function log(line: string) {
  lines.push(line)
  out.textContent = lines.join('\n')
}

type Counts = Record<string, [number, number]>

function record(counts: Counts, name: string, ok: boolean) {
  const bucket = (counts[name] ??= [0, 0])
  bucket[1] += 1
  if (ok) bucket[0] += 1
}

async function run() {
  const counts: Counts = {}
  const failures: string[] = []
  const captures: Capture[] = []

  status.textContent = 'loading the OCR engine…'
  const reader = new BrowserTextReader({ onProgress: (message) => { status.textContent = message } })
  await reader.load()

  for (const name of NAMES) {
    status.textContent = `reading ${name}…`
    const started = performance.now()
    let capture: Capture
    try {
      const truth = TRUTHS.get(`${name}.truth.json`)
      const url = SCREENSHOTS.get(`${name}.png`)
      if (!truth || !url) throw new Error(`no fixture for ${name}`)
      const blob = await (await fetch(url)).blob()
      const image = await decodeScreenshot(blob)
      const result = await analyzeImage(image, reader)
      capture = { name, ms: Math.round(performance.now() - started), truth, result }
    } catch (error) {
      capture = { name, ms: Math.round(performance.now() - started), truth: { rows: [] }, result: null, error: String(error) }
    }
    captures.push(capture)
  }

  for (const capture of captures) {
    if (!capture.result) {
      failures.push(`${capture.name}: ${capture.error}`)
      log(`${capture.name} ERROR ${capture.error}`)
      continue
    }
    const { truth, result } = capture
    const rowChecks = truth.rows.map((expected, index) => {
      const actual = result.rows[index]
      const checks: [string, boolean][] = []
      if ('username' in expected) {
        const ok = actual?.username === expected.username
        record(counts, 'username', ok)
        checks.push([
          ok ? 'user' : `user got ${JSON.stringify(actual?.username ?? null)} want ${JSON.stringify(expected.username)}`,
          ok,
        ])
      }
      if ('damage' in expected) {
        record(counts, 'damage', actual?.damage === expected.damage)
        checks.push([`dmg ${String(actual?.damage)}`, actual?.damage === expected.damage])
      }
      if ('team' in expected) {
        record(counts, 'team', actual?.color === expected.team)
        checks.push([String(actual?.color), actual?.color === expected.team])
      }
      return `    row ${index} ${checks.map(([label, ok]) => `${ok ? 'ok' : 'FAIL'}:${label}`).join(' ')}`
    })

    const scores = Object.fromEntries(result.teams.map((team) => [team.color, team.score]))
    const scoreOk =
      (truth.teams?.gold === undefined || scores.gold === truth.teams.gold) &&
      (truth.teams?.purple === undefined || scores.purple === truth.teams.purple)
    if (truth.teams?.gold !== undefined) record(counts, 'score', scores.gold === truth.teams.gold)
    if (truth.teams?.purple !== undefined) record(counts, 'score', scores.purple === truth.teams.purple)

    const winnerColor = result.winnerSlot === null ? null : result.teams[result.winnerSlot]?.color ?? null
    if (truth.winner) record(counts, 'winner', winnerColor === truth.winner)

    log(
      `${capture.name} ${capture.ms} ms  rows=${result.rows.length}  ` +
        `gold=${scores.gold} purple=${scores.purple} winner=${String(winnerColor)} ` +
        `${scoreOk ? '' : 'SCORE-FAIL '}${truth.winner === winnerColor ? '' : 'WINNER-FAIL '}` +
        `issues=${result.issues.map((entry) => entry.code).join(',') || 'none'}`,
    )
    for (const line of rowChecks) log(line)
  }

  const summary = Object.entries(counts)
    .sort()
    .map(([name, [correct, total]]) => {
      const ok = correct === total
      if (!ok) failures.push(`${name}: ${correct}/${total}`)
      return `${name.padEnd(9)} ${correct}/${total} ${ok ? 'ok' : 'FAIL'}`
    })

  log('')
  log(summary.join('\n'))
  log(failures.length ? `RESULT: FAIL (${failures.join('; ')})` : 'RESULT: PASS')
  status.textContent = failures.length ? 'failed' : 'done'

  const payload = { ok: failures.length === 0, counts, failures, captures: captures.map(({ name, ms, error }) => ({ name, ms, error })) }
  ;(window as unknown as { __lab: unknown }).__lab = payload
}

run().catch((error) => {
  status.textContent = 'crashed'
  log(`CRASH ${String(error)}`)
  ;(window as unknown as { __lab: unknown }).__lab = { ok: false, crash: String(error) }
})
