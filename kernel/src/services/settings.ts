import type { SqliteDatabase, SqliteExecutor } from "../sql";
import Value from "typebox/value";
import { parse, SettingsShape, type SettingsChange } from "@neo/client";
export type { SettingsShape } from "@neo/client";

export const SETTINGS_SCHEMA = async (tx: SqliteExecutor) => {
  await tx.exec(
    `CREATE TABLE neo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  );
};

const DEFAULTS: SettingsShape = {
  timezone: "UTC",
  model: null,
  thinking: null,
};

type SettingKey = keyof SettingsShape;

const isSettingKey = (key: string): key is SettingKey =>
  key in SettingsShape.properties;

const SETTING_KEYS = Object.keys(SettingsShape.properties).filter(isSettingKey);

export class Settings {
  private cache: SettingsShape | undefined;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly timezone?: string,
  ) {}

  async all() {
    if (this.cache) return this.cache;
    const rows = await this.db.all<{ key: string; value: string }>(
      `SELECT key, value FROM neo_settings`,
    );
    const stored = Object.fromEntries(
      rows.flatMap(({ key, value }) => {
        if (!isSettingKey(key)) return [];
        const parsed: unknown = JSON.parse(value);
        return Value.Check(SettingsShape.properties[key], parsed)
          ? [[key, parsed]]
          : [];
      }),
    );
    this.cache = parse(SettingsShape, {
      ...DEFAULTS,
      ...(this.timezone ? { timezone: this.timezone } : {}),
      ...stored,
    });
    return this.cache;
  }

  async get<K extends keyof SettingsShape>(key: K) {
    return (await this.all())[key];
  }

  async update(change: SettingsChange) {
    if (change.timezone !== undefined) checkTimezone(change.timezone);
    for (const key of SETTING_KEYS) {
      const value = change[key];
      if (value === undefined) continue;
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

function checkTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error(`Unknown timezone ${timezone}`);
  }
}
