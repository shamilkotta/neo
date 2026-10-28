// Neo's only database contract: chord's portable async SQLite facade.
// Hosts provide it (bun:sqlite, node:sqlite, Durable Object ctx.storage.sql).
export type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/chord/sqlite";
