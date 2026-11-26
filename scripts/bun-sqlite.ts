import { Database as Sqlite } from 'bun:sqlite'
import { databaseFromExecutor, type Executor } from '../src/server/libsql'
import type { Database } from '../src/worker/db'

/**
 * A libSQL-shaped executor backed by Bun's built-in SQLite. It lets the tests
 * and the local harness (`scripts/serve-node.ts`) run the exact production
 * adapter code against a real SQLite engine, with no network and no Turso
 * credentials.
 */
export function bunSqliteExecutor(
  filename = ':memory:',
): Executor & { raw: Sqlite } {
  const db = new Sqlite(filename)
  return {
    raw: db,
    async execute({ sql, args }) {
      const statement = db.prepare(sql)
      const columns = statement.columnNames
      // SELECT, PRAGMA and INSERT ... RETURNING produce columns; others do not.
      if (columns.length > 0) {
        const rows = statement.all(...(args as never[])) as Record<
          string,
          unknown
        >[]
        return [rows.map((row) => columns.map((column) => row[column])), columns]
      }
      statement.run(...(args as never[]))
      return [[], []]
    },
    async batch(statements) {
      const write = db.transaction(
        (list: { sql: string; args: unknown[] }[]) => {
          for (const statement of list)
            db.prepare(statement.sql).run(...(statement.args as never[]))
        },
      )
      write(statements)
    },
  }
}

export function createBunSqliteDatabase(filename = ':memory:'): Database {
  return databaseFromExecutor(bunSqliteExecutor(filename))
}
