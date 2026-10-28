import { Database, type Statement } from "bun:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@neo/kernel";

/**
 * The `db` port on Bun: bun:sqlite behind chord's async facade.
 *
 * Bun has no node:sqlite, so this mirrors chord's NodeSqliteDatabase: one connection, operations
 * in call order, a transaction holds the queue until it settles.
 */

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class BunExecutor implements SqliteExecutor {
  constructor(
    protected readonly database: Database,
    private readonly statements: Map<string, Statement>,
    private readonly gate: <T>(op: () => T) => Promise<T>,
  ) {}
  exec(sql: string): Promise<void> {
    return this.gate(() => void this.database.run(sql));
  }
  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.gate(
      () => void this.statement(sql).run(...(params as never[])),
    );
  }
  get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    return this.gate(
      () =>
        (this.statement(sql).get(...(params as never[])) ?? undefined) as
          T | undefined,
    );
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.gate(
      () => this.statement(sql).all(...(params as never[])) as T[],
    );
  }
  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

export class BunSqlite extends BunExecutor implements SqliteDatabase {
  private readonly queue: SerialQueue;
  private readonly cache: Map<string, Statement>;
  private closed = false;

  constructor(database: Database) {
    const queue = new SerialQueue();
    const cache = new Map<string, Statement>();
    super(database, cache, (op) => queue.run(op));
    this.queue = queue;
    this.cache = cache;
  }

  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      this.database.run("BEGIN IMMEDIATE");
      const scope = { active: true };
      const tx = new BunExecutor(this.database, this.cache, async (op) => {
        if (!scope.active)
          throw new Error("SQLite transaction handle is no longer active");
        return op();
      });
      try {
        const result = await callback(tx);
        scope.active = false;
        this.database.run("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.run("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback failed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.queue.run(() => {
      if (this.closed) return;
      this.closed = true;
      for (const statement of this.cache.values()) statement.finalize();
      this.cache.clear();
      this.database.close();
    });
  }
}

export function openBunSqlite(path: string): BunSqlite {
  const database = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") {
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = NORMAL");
  }
  database.run("PRAGMA busy_timeout = 5000");
  return new BunSqlite(database);
}
