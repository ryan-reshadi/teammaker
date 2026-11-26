import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/auth'
import { createBunSqliteDatabase } from './bun-sqlite'

/**
 * Local harness for the Vercel build: serves the same Hono app the serverless
 * function serves, on loopback, with a SQLite file instead of Turso. A loopback
 * origin with no auth config is the local-preview identity, so every route is
 * exercisable with curl.
 */
const databasePath = process.env.DB_PATH ?? '.data/serve-node.db'
if (databasePath !== ':memory:')
  mkdirSync(dirname(databasePath), { recursive: true })

const env: Env = { DB: createBunSqliteDatabase(databasePath) }
const app = createApp()

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 5174),
  fetch: (request) => app.fetch(request, env),
})

console.log(`Vercel-shaped API on http://127.0.0.1:${server.port} (${databasePath})`)
