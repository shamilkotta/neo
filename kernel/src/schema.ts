import { AGENT_SCHEMA } from "./agent/agents";
import { REGISTRY_SCHEMA } from "./coordinator/registry";
import { MAILBOX_SCHEMA } from "./agent/mailbox";
import { MESSAGING_SCHEMA } from "./agent/messaging";
import { SCHEDULES_SCHEMA } from "./agent/schedules";
import { EVENTS_SCHEMA } from "./services/events";
import { HISTORY_SCHEMA } from "./services/history";
import { MEMORY_SCHEMA } from "./services/memory";
import { PROVIDERS_SCHEMA } from "./services/providers";
import { SECRETS_SCHEMA } from "./services/secrets";
import { SETTINGS_SCHEMA } from "./services/settings";
import type { SqliteDatabase, SqliteExecutor } from "./sql";
import { VFS_SCHEMA } from "./vfs/vfs";

const META = async (tx: SqliteExecutor) => {
  await tx.exec(
    `CREATE TABLE neo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  );
};

/** One agent's database (an agent DO). */
const AGENT_TABLES: ((tx: SqliteExecutor) => Promise<void>)[] = [
  META,
  EVENTS_SCHEMA,
  AGENT_SCHEMA,
  MAILBOX_SCHEMA,
  MESSAGING_SCHEMA,
  SCHEDULES_SCHEMA,
  MEMORY_SCHEMA,
  HISTORY_SCHEMA,
  VFS_SCHEMA,
];

/** The coordinator's database: what all agents share. */
const COORDINATOR_TABLES: ((tx: SqliteExecutor) => Promise<void>)[] = [
  META,
  EVENTS_SCHEMA,
  SETTINGS_SCHEMA,
  SECRETS_SCHEMA,
  PROVIDERS_SCHEMA,
  REGISTRY_SCHEMA,
  VFS_SCHEMA,
];

async function create(
  db: SqliteDatabase,
  tables: ((tx: SqliteExecutor) => Promise<void>)[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const make of tables) await make(tx);
  });
}

export const createAgentSchema = (db: SqliteDatabase) =>
  create(db, AGENT_TABLES);
export const createCoordinatorSchema = (db: SqliteDatabase) =>
  create(db, COORDINATOR_TABLES);

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
