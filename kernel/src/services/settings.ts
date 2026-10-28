import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type { SettingsShape } from "@neo/client";
export type { SettingsShape } from "@neo/client";

export const SETTINGS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(
    `CREATE TABLE neo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  );
};

const DEFAULTS: SettingsShape = {
  memoryLimit: 128,
  busyMessageMode: "queue",
  timezone: "UTC",
};

export class Settings {
  private cache: SettingsShape | undefined;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly timezone?: string,
  ) {}

  async all(): Promise<SettingsShape> {
    if (this.cache) return this.cache;
    const rows = await this.db.all<{ key: string; value: string }>(
      `SELECT key, value FROM neo_settings`,
    );
    const out = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
    if (this.timezone) out.timezone = this.timezone;
    for (const row of rows) {
      if (row.key in DEFAULTS) out[row.key] = JSON.parse(row.value);
    }
    this.cache = out as unknown as SettingsShape;
    return this.cache;
  }

  async get<K extends keyof SettingsShape>(key: K): Promise<SettingsShape[K]> {
    return (await this.all())[key];
  }

  async update(change: Partial<SettingsShape>): Promise<SettingsShape> {
    for (const [key, value] of Object.entries(change)) {
      if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
      validate(key as keyof SettingsShape, value);
      await this.db.run(
        `INSERT INTO neo_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        JSON.stringify(value),
      );
    }
    this.cache = undefined;
    return this.all();
  }
}

function validate(key: keyof SettingsShape, value: unknown): void {
  switch (key) {
    case "memoryLimit":
      if (![64, 128, 256, 512].includes(value as number))
        throw new Error("memoryLimit is 64, 128, 256 or 512");
      return;
    case "busyMessageMode":
      if (value !== "queue" && value !== "steer")
        throw new Error("busyMessageMode is queue or steer");
      return;
    case "timezone":
      try {
        new Intl.DateTimeFormat("en", { timeZone: String(value) });
      } catch {
        throw new Error(`Unknown timezone ${String(value)}`);
      }
      return;
    default:
      if (typeof value !== "object" || value === null)
        throw new Error(`${key} is an object`);
  }
}
