/**
 * Runs the built Vercel function (`api/index.js`, the file Vercel deploys) under
 * plain Node, the runtime Vercel uses, against a local SQLite file. This is the
 * closest local stand-in for production: real `node`, real libSQL driver, real
 * `@hono/node-server` (req, res) plumbing.
 *
 *   bun run build:api && bun run serve:api
 *
 * A loopback origin with no auth config is the local-preview identity, so every
 * route is reachable with curl. Set PORT to change the port (default 5175).
 */
import http from 'node:http'
import { mkdirSync } from 'node:fs'

const databasePath = process.env.DB_PATH ?? '.tmp-api/teammaker.db'
if (databasePath !== ':memory:') {
  mkdirSync(databasePath.slice(0, databasePath.lastIndexOf('/')) || '.', {
    recursive: true,
  })
}

process.env.TURSO_DATABASE_URL ??=
  'file:' + process.cwd().replaceAll('\\', '/') + '/' + databasePath

const { default: handler } = await import('../api/index.js')

const server = http.createServer(handler)
const port = Number(process.env.PORT ?? 5175)
server.listen(port, '127.0.0.1', () => {
  console.log(
    `node runtime API on http://127.0.0.1:${server.address().port} (${process.env.TURSO_DATABASE_URL})`,
  )
})
