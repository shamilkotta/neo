import { AGENTS_SCHEMA } from "./agent/agents";
import { MAILBOX_SCHEMA } from "./agent/mailbox";
import { SCHEDULES_SCHEMA } from "./agent/schedules";
import { EVENTS_SCHEMA } from "./services/events";
import { HISTORY_SCHEMA } from "./services/history";
import { MEMORY_SCHEMA } from "./services/memory";
import { PROVIDERS_SCHEMA } from "./services/providers";
import { SECRETS_SCHEMA } from "./services/secrets";
import { SETTINGS_SCHEMA } from "./services/settings";
import type { SqliteDatabase, SqliteExecutor } from "./sql";
import { VFS_SCHEMA } from "./vfs/vfs";

/**
 * Neo's schema: every table, created at once on a new database. Each module owns its tables.
 * There is no backward compatibility and no migrations: to change a table, edit its definition
 * where it lives and wipe local data.
 *
 * Table families, so export can treat them by name:
 * - `neo_*`  Neo's own state; travels with the instance.
 * - `pi_*`   Pi Durable's state (transcript, tasks, submissions; Pi creates these itself).
 * - `vfs_*`  the workspace tree and small file bytes; travels (large bytes are in the blob store).
 * - `host_*` this host's own bookkeeping; never travels.
 */
const TABLES: ((tx: SqliteExecutor) => Promise<void>)[] = [
  async (tx) => {
    await tx.exec(`CREATE TABLE neo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  },
  SETTINGS_SCHEMA,
  SECRETS_SCHEMA,
  PROVIDERS_SCHEMA,
  EVENTS_SCHEMA,
  AGENTS_SCHEMA,
  MAILBOX_SCHEMA,
  SCHEDULES_SCHEMA,
  MEMORY_SCHEMA,
  HISTORY_SCHEMA,
  VFS_SCHEMA,
];

/** Creates every table on a new database, in one transaction. */
export async function createSchema(db: SqliteDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    for (const create of TABLES) await create(tx);
  });
}

export async function hasTable(
  db: SqliteDatabase,
  name: string,
): Promise<boolean> {
  return (
    (await db.get(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      name,
    )) !== undefined
  );
}

/** One `neo_meta` value. */
export async function getMeta(
  db: SqliteExecutor,
  key: string,
): Promise<string | undefined> {
  return (
    await db.get<{ value: string }>(
      `SELECT value FROM neo_meta WHERE key = ?`,
      key,
    )
  )?.value;
}

export async function setMeta(
  db: SqliteExecutor,
  key: string,
  value: string,
): Promise<void> {
  await db.run(
    `INSERT INTO neo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}
