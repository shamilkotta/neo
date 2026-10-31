import {
  aesKey,
  open,
  openText,
  randomBytes,
  seal,
  toBase64,
  fromBase64,
} from "../crypto";
import type { SqliteDatabase, SqliteExecutor } from "../sql";

export const SECRETS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`);
};

export class Secrets {
  private dek: CryptoKey | undefined;
  private dekRaw: Uint8Array | undefined;
  private cachedValues: string[] | undefined;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly masterKey: CryptoKey,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    const row = await this.db.get<{ value: string }>(
      `SELECT value FROM neo_meta WHERE key = 'dek'`,
    );
    if (row) {
      this.dekRaw = await open(this.masterKey, row.value, "neo-dek");
    } else {
      this.dekRaw = randomBytes(32);
      await this.storeDek(this.dekRaw);
    }
    this.dek = await aesKey(this.dekRaw);
  }

  async storeDek(raw: Uint8Array): Promise<void> {
    const wrapped = await seal(this.masterKey, raw, "neo-dek");
    await this.db.run(
      `INSERT INTO neo_meta (key, value) VALUES ('dek', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      wrapped,
    );
  }

  rawDek(): Uint8Array {
    if (!this.dekRaw) throw new Error("Secrets are not initialized");
    return this.dekRaw;
  }

  async set(name: string, value: string): Promise<void> {
    const sealed = await seal(this.key(), value, `secret:${name}`);
    await this.db.run(
      `INSERT INTO neo_secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      name,
      sealed,
      this.now(),
    );
    this.cachedValues = undefined;
  }

  async get(name: string): Promise<string | undefined> {
    return this.getRaw(name);
  }

  async getRaw(name: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>(
      `SELECT value FROM neo_secrets WHERE name = ?`,
      name,
    );
    return row ? openText(this.key(), row.value, `secret:${name}`) : undefined;
  }

  async delete(name: string): Promise<void> {
    await this.db.run(`DELETE FROM neo_secrets WHERE name = ?`, name);
    this.cachedValues = undefined;
  }

  async list(): Promise<{ name: string; updatedAt: number }[]> {
    const rows = await this.db.all<{ name: string; updated_at: number }>(
      `SELECT name, updated_at FROM neo_secrets ORDER BY name`,
    );
    return rows.map((r) => ({ name: r.name, updatedAt: r.updated_at }));
  }

  async values(): Promise<string[]> {
    if (this.cachedValues) return this.cachedValues;
    const names = await this.list();
    const values: string[] = [];
    for (const { name } of names) {
      const value = await this.getRaw(name);
      if (!value || value.length < 6) continue;
      values.push(value);
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object")
          for (const v of Object.values(parsed))
            if (typeof v === "string" && v.length >= 6)
              values.push(v, ...v.split(" ").filter((p) => p.length >= 6));
      } catch {}
    }
    this.cachedValues = [...new Set(values)].sort(
      (a, b) => b.length - a.length,
    );
    return this.cachedValues;
  }

  private key(): CryptoKey {
    if (!this.dek) throw new Error("Secrets are not initialized");
    return this.dek;
  }
}

export async function masterKeyFromBase64(text: string): Promise<CryptoKey> {
  return aesKey(fromBase64(text.trim()));
}

export function newMasterKeyBase64(): string {
  return toBase64(randomBytes(32));
}
