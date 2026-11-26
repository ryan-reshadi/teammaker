import { createClient } from '@libsql/client'
import type { Database, Statement } from '../worker/db'

/**
 * libSQL speaks SQLite, so the app's SQL runs unchanged: hosts that are not
 * Cloudflare (Vercel, Node, Bun) connect through this adapter instead of a D1
 * binding. Queries use positional `?` arguments, `RETURNING` and `PRAGMA`,
 * all of which libSQL supports.
 */
type Result = [rows: unknown[][], columns: string[]]

export type Executor = {
  execute(input: { sql: string; args: unknown[] }): Promise<Result>
  batch(statements: { sql: string; args: unknown[] }[]): Promise<void>
}

const toRecord = (values: unknown[], columns: string[]): Record<string, unknown> => {
  const record: Record<string, unknown> = {}
  columns.forEach((column, index) => {
    record[column] = values[index]
  })
  return record
}

class LibsqlStatement implements Statement {
  constructor(
    private readonly executor: Executor,
    readonly sql: string,
    readonly args: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new LibsqlStatement(this.executor, this.sql, values)
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const [values, columns] = await this.executor.execute({
      sql: this.sql,
      args: this.args,
    })
    const results = values.map((row) => toRecord(row, columns)) as T[]
    return { results }
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.all<T>()
    return results[0] ?? null
  }

  async run(): Promise<unknown> {
    await this.executor.execute({ sql: this.sql, args: this.args })
    return { ok: true }
  }
}

class LibsqlDatabase implements Database {
  constructor(private readonly executor: Executor) {}

  prepare(sql: string): Statement {
    return new LibsqlStatement(this.executor, sql)
  }

  /** Batches run as one write transaction, like a D1 batch. */
  async batch(statements: Statement[]): Promise<unknown> {
    await this.executor.batch(
      statements.map((statement) => {
        const { sql, args } = statement as LibsqlStatement
        return { sql, args }
      }),
    )
    return { ok: true }
  }
}

/** Builds the database surface over any executor, which tests can supply. */
export function databaseFromExecutor(executor: Executor): Database {
  return new LibsqlDatabase(executor)
}

export function createLibsqlDatabase(url: string, authToken?: string): Database {
  const client = createClient({ url, authToken })
  return databaseFromExecutor({
    async execute({ sql, args }) {
      // libSQL hands rows back as arrays that also carry column names.
      const result = await client.execute({ sql, args: args as never })
      const columns = result.columns
      const values = result.rows.map((row) =>
        columns.map((column) => row[column]),
      )
      return [values, columns]
    },
    async batch(statements) {
      await client.batch(
        statements.map(({ sql, args }) => ({ sql, args: args as never })),
        'write',
      )
    },
  })
}
