#!/usr/bin/env node
/**
 * Runs an `ocr/` entrypoint through the project's own virtualenv.
 *
 * PaddleOCR is a native package that lives only in `ocr/.venv`; the `python` on
 * PATH does not have it, so `python ocr/serve.py` fails in a way that looks like
 * a bug in the service. This wrapper resolves the venv interpreter on Windows
 * and POSIX, refuses to run without it, and passes the real exit code through.
 *
 *   bun run ocr:serve      # the HTTP service
 *   bun run ocr:test       # the Python test suite
 *   bun run ocr:captures   # measure real screenshots
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OCR = join(ROOT, 'ocr')
const VENV = join(OCR, '.venv')

const TARGETS = {
  serve: join(OCR, 'serve.py'),
  test: join(OCR, 'tests', 'run_tests.py'),
  captures: join(OCR, 'tools', 'measure_captures.py'),
}

const onWindows = process.platform === 'win32'
const install = onWindows
  ? '  python -m venv ocr\\.venv\n  ocr\\.venv\\Scripts\\python.exe -m pip install -r ocr\\requirements.txt'
  : '  python3 -m venv ocr/.venv\n  ocr/.venv/bin/pip install -r ocr/requirements.txt'

function fail(message) {
  console.error(`\nrivals-ocr: ${message}\n`)
  process.exit(1)
}

const mode = process.argv[2]
const target = TARGETS[mode]
if (!target)
  fail(
    `unknown target “${mode ?? ''}”. Expected one of: ${Object.keys(TARGETS).join(', ')}.`,
  )

const candidates = onWindows
  ? [join(VENV, 'Scripts', 'python.exe')]
  : [join(VENV, 'bin', 'python3'), join(VENV, 'bin', 'python')]
const python = candidates.find((path) => existsSync(path))
if (!python)
  fail(
    `the OCR service needs its own Python virtualenv with PaddleOCR, and ${VENV} does not exist.\n` +
      `Create it once, then run this command again:\n${install}\n`,
  )

// Checked once here so a missing engine is one clear message rather than a
// traceback from inside the pipeline, or a silently skipped engine test.
const probe = spawnSync(python, ['-c', 'import paddleocr'], { stdio: 'ignore' })
if (probe.error)
  fail(`could not run ${python}: ${probe.error.message}`)
if (probe.status !== 0)
  fail(
    `PaddleOCR is not installed in ${VENV}, so this command cannot run.\n` +
      `Install the service dependencies:\n  ${python} -m pip install -r ${join(OCR, 'requirements.txt')}\n`,
  )

const child = spawnSync(python, [target, ...process.argv.slice(3)], {
  stdio: 'inherit',
  cwd: OCR,
  env: process.env,
})
if (child.error) fail(`could not run ${target}: ${child.error.message}`)
process.exit(child.status ?? 1)
