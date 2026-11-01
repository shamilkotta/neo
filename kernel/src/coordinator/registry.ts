import type {
  AgentProfile,
  AgentStatus,
  AgentSummary,
  NewAgent,
  ProfileChange,
} from "@neo/client";
import { PRIMARY_AGENT_ID } from "../agent/agents";
import type { SqliteDatabase, SqliteExecutor } from "../sql";

export const REGISTRY_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    title TEXT,
    description TEXT,
    instructions TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    create_key TEXT UNIQUE,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting')),
    status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`);
};

export const AGENT_LIMIT = 50;
const NAME_MAX = 60;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 1_000;
const INSTRUCTIONS_MAX = 8_000;

interface Row {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  instructions: string | null;
  is_primary: number;
  created_by: string | null;
  create_key: string | null;
  state: "active" | "deleting";
  status: string | null;
  created_at: number;
  updated_at: number;
}

export class Registry {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number,
  ) {}

  async ensurePrimary(): Promise<AgentProfile> {
    const time = this.now();
    await this.db.run(
      `INSERT INTO neo_agents (id, name, is_primary, created_at, updated_at) VALUES (?, 'Neo', 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
      PRIMARY_AGENT_ID,
      time,
      time,
    );
    return (await this.get(PRIMARY_AGENT_ID))!;
  }

  async get(id: string): Promise<AgentProfile | undefined> {
    const row = await this.row(id);
    return row && row.state === "active" ? toProfile(row) : undefined;
  }

  async row(id: string): Promise<Row | undefined> {
    return this.db.get<Row>(`SELECT * FROM neo_agents WHERE id = ?`, id);
  }

  async list(): Promise<AgentSummary[]> {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_agents WHERE state = 'active' ORDER BY is_primary DESC, created_at`,
    );
    return rows.map((row) => ({
      ...toProfile(row),
      status: row.status ? (JSON.parse(row.status) as AgentStatus) : null,
    }));
  }

  async ids(): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM neo_agents ORDER BY created_at`,
    );
    return rows.map((r) => r.id);
  }

  async create(
    input: NewAgent,
    by: string | null,
    key?: string,
  ): Promise<AgentProfile> {
    if (key) {
      const made = await this.db.get<Row>(
        `SELECT * FROM neo_agents WHERE create_key = ?`,
        key,
      );
      if (made) return toProfile(made);
    }
    const fields = clean(input);
    if (!fields.name) throw new RegistryError("name is required");
    const count = await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM neo_agents`,
    );
    if ((count?.n ?? 0) >= AGENT_LIMIT)
      throw new RegistryError(`An instance has at most ${AGENT_LIMIT} agents`);
    if (await this.byName(fields.name))
      throw new RegistryError(`An agent named "${fields.name}" already exists`);
    const id = await this.freeId(fields.name);
    const time = this.now();
    await this.db.run(
      `INSERT INTO neo_agents (id, name, title, description, instructions, created_by, create_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      fields.name,
      fields.title ?? null,
      fields.description ?? null,
      fields.instructions ?? null,
      by,
      key ?? null,
      time,
      time,
    );
    return (await this.get(id))!;
  }

  async update(id: string, change: ProfileChange): Promise<AgentProfile> {
    const current = await this.get(id);
    if (!current) throw new RegistryError(`No agent ${id}`);
    const fields = clean(change);
    if (change.name !== undefined && !fields.name)
      throw new RegistryError("name is empty");
    if (fields.name && fields.name.toLowerCase() !== current.name.toLowerCase()) {
      if (await this.byName(fields.name))
        throw new RegistryError(`An agent named "${fields.name}" already exists`);
    }
    await this.db.run(
      `UPDATE neo_agents SET name = ?, title = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?`,
      fields.name ?? current.name,
      fields.title === undefined ? current.title : fields.title,
      fields.description === undefined ? current.description : fields.description,
      fields.instructions === undefined ? current.instructions : fields.instructions,
      this.now(),
      id,
    );
    return (await this.get(id))!;
  }

  async setStatus(id: string, status: AgentStatus): Promise<boolean> {
    const changed = await this.db.get(
      `UPDATE neo_agents SET status = ? WHERE id = ? AND state = 'active' AND (status IS NULL OR json_extract(status, '$.at') <= ?) RETURNING id`,
      JSON.stringify(status),
      id,
      status.at,
    );
    return changed !== undefined;
  }

  async markDeleting(id: string): Promise<void> {
    await this.db.run(
      `UPDATE neo_agents SET state = 'deleting', updated_at = ? WHERE id = ?`,
      this.now(),
      id,
    );
  }

  async deleting(): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM neo_agents WHERE state = 'deleting'`,
    );
    return rows.map((r) => r.id);
  }

  async remove(id: string): Promise<void> {
    await this.db.run(`DELETE FROM neo_agents WHERE id = ?`, id);
  }

  private async byName(name: string): Promise<Row | undefined> {
    return this.db.get<Row>(`SELECT * FROM neo_agents WHERE name = ?`, name);
  }

  private async freeId(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "agent";
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!(await this.row(id))) return id;
    }
  }
}

export class RegistryError extends Error {}

function clean(input: ProfileChange): ProfileChange {
  const out: ProfileChange = {};
  const text = (
    key: keyof ProfileChange,
    max: number,
    value: string | null | undefined,
  ) => {
    if (value === undefined) return;
    if (value !== null && typeof value !== "string")
      throw new RegistryError(`${key} is text`);
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > max)
      throw new RegistryError(`${key} is at most ${max} characters`);
    (out as Record<string, string | null>)[key] = trimmed || null;
  };
  text("name", NAME_MAX, input.name);
  text("title", TITLE_MAX, input.title);
  text("description", DESCRIPTION_MAX, input.description);
  text("instructions", INSTRUCTIONS_MAX, input.instructions);
  if (out.name === null) out.name = "";
  return out;
}

function toProfile(row: Row): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    primary: row.is_primary === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
