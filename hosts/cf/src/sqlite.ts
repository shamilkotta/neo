import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare";

/**
 * The `db` port on Cloudflare: the Durable Object's own SQLite storage behind chord's async
 * facade. Neo's tables and Pi's share it, and a commit is one storage transaction.
 */
export class CloudflareSqlite extends DurableObjectSqliteDatabase {}
