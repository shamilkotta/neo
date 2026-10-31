import { fromBase64, toBase64 } from "../crypto";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "../sql";

/**
 * A logical, host-independent copy of the instance database (ported from neo2).
 *
 * Why logical and not a file copy: a Durable Object has no file access (no `VACUUM INTO`, no
 * backup API), so the only copy that works on every host is reading rows through SQL. The same
 * records load into bun:sqlite and Durable Object SQLite.
 *
 * Rules:
 * - `sqlite_*`, `_cf_*` and `__*` (platform) and `host_*` (this host's own) never leave.
 * - Virtual tables travel as their CREATE statement only. Their shadow tables are skipped and the
 *   index is rebuilt on load, so every FTS5 table must use external content (`content=`).
 * - Indexes and triggers are created after the rows, so loading doesn't fire triggers.
 */

export type SnapshotValue =
  | null
  | number
  | string
  | { $b: string }
  | { $i: string };

export type SnapshotRecord =
  | {
      t: "schema";
      type: "table" | "index" | "trigger" | "view";
      name: string;
      table: string;
      sql: string;
      virtual?: boolean;
    }
  | { t: "rows"; table: string; columns: string[]; rows: SnapshotValue[][] };

// `__*` covers platform tables such as local Miniflare's `__miniflare_do_name`.
const PLATFORM_PREFIXES = ["sqlite_", "_cf_", "__"];
const EXCLUDED_PREFIXES = [...PLATFORM_PREFIXES, "host_"];
const ROW_BATCH = 200;
/** One rows record holds about this much; a single larger row is a record of its own. */
const RECORD_BYTES = 1024 * 1024;

interface MasterRow {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  tbl_name: string;
  sql: string | null;
}

const excluded = (name: string) =>
  EXCLUDED_PREFIXES.some((p) => name.startsWith(p));
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const isVirtual = (sql: string) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql);

async function readSchema(db: SqliteExecutor): Promise<MasterRow[]> {
  const rows = await db.all<MasterRow>(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`,
  );
  const virtualTables = rows
    .filter((r) => r.type === "table" && isVirtual(r.sql!))
    .map((r) => r.name);
  const isShadow = (name: string) =>
    virtualTables.some((v) => name !== v && name.startsWith(`${v}_`));
  return rows.filter(
    (r) => !excluded(r.name) && !excluded(r.tbl_name) && !isShadow(r.tbl_name),
  );
}

function encodeValue(value: unknown): SnapshotValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return { $i: value.toString() };
  if (value instanceof Uint8Array) return { $b: toBase64(value) };
  if (value instanceof ArrayBuffer)
    return { $b: toBase64(new Uint8Array(value)) };
  throw new Error(`Unsupported SQLite value: ${typeof value}`);
}

function decodeValue(value: SnapshotValue): SqliteValue {
  if (value === null || typeof value === "number" || typeof value === "string")
    return value;
  if ("$b" in value) return fromBase64(value.$b);
  // Bigints only appear beyond 2^53; DO SQL can't bind bigint, so narrow when it is safe.
  const big = BigInt(value.$i);
  return big <= BigInt(Number.MAX_SAFE_INTEGER) &&
    big >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(big)
    : big;
}

/** Streams the database, a bounded record at a time. Call it while nothing writes (sealed). */
export async function* dumpDatabase(
  db: SqliteExecutor,
): AsyncGenerator<SnapshotRecord> {
  const schema = await readSchema(db);
  for (const item of schema)
    yield {
      t: "schema",
      type: item.type,
      name: item.name,
      table: item.tbl_name,
      sql: item.sql!,
      ...(item.type === "table" && isVirtual(item.sql!)
        ? { virtual: true }
        : {}),
    };
  for (const item of schema) {
    if (item.type !== "table" || isVirtual(item.sql!)) continue;
    const columns = (
      await db.all<{ name: string }>(
        `SELECT name FROM pragma_table_info(?)`,
        item.name,
      )
    ).map((c) => c.name);
    const order = /WITHOUT\s+ROWID/i.test(item.sql!) ? "" : "ORDER BY rowid ";
    const query = `SELECT ${columns.map(quote).join(", ")} FROM ${quote(item.name)} ${order}LIMIT ? OFFSET ?`;
    // Row sizes first (length() doesn't load a blob), so a record holds at most ~RECORD_BYTES.
    const sizeOf =
      columns.map((c) => `coalesce(length(${quote(c)}), 0)`).join(" + ") || "0";
    const sizes = `SELECT ${sizeOf} AS n FROM ${quote(item.name)} ${order}LIMIT ? OFFSET ?`;
    for (let offset = 0, take = 0; ; offset += take) {
      const lengths = await db.all<{ n: number }>(sizes, ROW_BATCH, offset);
      if (lengths.length === 0) break;
      take = 0;
      for (let bytes = 0; take < lengths.length; take++) {
        bytes += Number(lengths[take]!.n);
        if (take > 0 && bytes > RECORD_BYTES) break;
      }
      const rows = await db.all<Record<string, unknown>>(query, take, offset);
      if (rows.length === 0) break;
      yield {
        t: "rows",
        table: item.name,
        columns,
        rows: rows.map((r) => columns.map((c) => encodeValue(r[c]))),
      };
      if (take === lengths.length && lengths.length < ROW_BATCH) break;
    }
  }
}

/**
 * Loads a dump into an empty database, in batches of rows: one transaction per batch, because the
 * records arrive over the network and a Durable Object can't hold a transaction open across I/O.
 * The caller makes the whole load atomic with an import marker (see `Neo.importBundle`).
 */
export async function loadDatabase(
  db: SqliteDatabase,
  records: AsyncIterable<SnapshotRecord>,
  batchRows = 500,
): Promise<void> {
  // Indexes, triggers and FTS rebuilds wait for the rows (a handful of statements).
  const deferred: string[] = [];
  const rebuild: string[] = [];
  let batch: { sql: string; values: SqliteValue[] }[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const statements = batch;
    batch = [];
    batchBytes = 0;
    await db.transaction(async (tx) => {
      for (const s of statements) await tx.run(s.sql, ...s.values);
    });
  };
  for await (const record of records) {
    if (record.t === "schema") {
      if (record.type !== "table") {
        deferred.push(record.sql);
        continue;
      }
      await flush();
      await db.exec(record.sql);
      if (record.virtual) rebuild.push(record.name);
      continue;
    }
    const placeholders = record.columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${quote(record.table)} (${record.columns.map(quote).join(", ")}) VALUES (${placeholders})`;
    for (const row of record.rows) {
      const values = row.map(decodeValue);
      batch.push({ sql, values });
      for (const v of values)
        batchBytes +=
          v instanceof Uint8Array
            ? v.length
            : typeof v === "string"
              ? v.length
              : 8;
      if (batch.length >= batchRows || batchBytes >= RECORD_BYTES)
        await flush();
    }
  }
  await flush();
  await db.transaction(async (tx) => {
    for (const sql of deferred) await tx.exec(sql);
    for (const name of rebuild)
      await tx.run(
        `INSERT INTO ${quote(name)}(${quote(name)}) VALUES ('rebuild')`,
      );
  });
}

/** Drops every table, index, trigger and view but the platform's, `host_*` included. */
export async function wipeDatabase(db: SqliteDatabase): Promise<void> {
  const rows = await db.all<MasterRow>(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL`,
  );
  const keep = (name: string) =>
    PLATFORM_PREFIXES.some((p) => name.startsWith(p));
  for (const type of ["trigger", "view", "index", "table"] as const) {
    for (const row of rows.filter(
      (r) => r.type === type && !keep(r.name) && !keep(r.tbl_name),
    )) {
      // Shadow tables of a virtual table go with it.
      if (
        type === "table" &&
        !(await db.get(`SELECT 1 FROM sqlite_master WHERE name = ?`, row.name))
      )
        continue;
      await db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${quote(row.name)}`);
    }
  }
}
