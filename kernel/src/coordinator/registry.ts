import { present } from "../errors";
import {
  agentId,
  type AgentId,
  AgentStatus,
  type NewAgent,
  type ProfileChange,
  parseJson,
} from "@neo/client";
import { PRIMARY_AGENT_ID } from "../agent/agents";
import type { SqliteDatabase, SqliteExecutor } from "../sql";

export const REGISTRY_SCHEMA = async (tx: SqliteExecutor) => {
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
  id: AgentId;
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

  async ensurePrimary() {
    const time = this.now();
    await this.db.run(
      `INSERT INTO neo_agents (id, name, is_primary, created_at, updated_at) VALUES (?, 'Neo', 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
      PRIMARY_AGENT_ID,
      time,
      time,
    );
    return present(
      await this.get(PRIMARY_AGENT_ID),
      `agent ${PRIMARY_AGENT_ID}`,
    );
  }

  async get(id: AgentId) {
    const row = await this.row(id);
    return row && row.state === "active" ? toProfile(row) : undefined;
  }

  async row(id: AgentId) {
    return this.db.get<Row>(`SELECT * FROM neo_agents WHERE id = ?`, id);
  }

  async list() {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_agents WHERE state = 'active' ORDER BY is_primary DESC, created_at`,
    );
    return rows.map((row) => ({
      ...toProfile(row),
      status: row.status ? parseJson(AgentStatus, row.status) : null,
    }));
  }

  async ids() {
    const rows = await this.db.all<{ id: AgentId }>(
      `SELECT id FROM neo_agents ORDER BY created_at`,
    );
    return rows.map((r) => r.id);
  }

  async create(input: NewAgent, by: string | null, key?: string) {
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
    return present(await this.get(id), `agent ${id}`);
  }

  async update(id: AgentId, change: ProfileChange) {
    const current = await this.get(id);
    if (!current) throw new RegistryError(`No agent ${id}`);
    const fields = clean(change);
    if (change.name !== undefined && !fields.name)
      throw new RegistryError("name is empty");
    if (
      fields.name &&
      fields.name.toLowerCase() !== current.name.toLowerCase()
    ) {
      if (await this.byName(fields.name))
        throw new RegistryError(
          `An agent named "${fields.name}" already exists`,
        );
    }
    await this.db.run(
      `UPDATE neo_agents SET name = ?, title = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?`,
      fields.name ?? current.name,
      fields.title === undefined ? current.title : fields.title,
      fields.description === undefined
        ? current.description
        : fields.description,
      fields.instructions === undefined
        ? current.instructions
        : fields.instructions,
      this.now(),
      id,
    );
    return present(await this.get(id), `agent ${id}`);
  }

  async setStatus(id: AgentId, status: AgentStatus) {
    const changed = await this.db.get(
      `UPDATE neo_agents SET status = ? WHERE id = ? AND state = 'active' AND (status IS NULL OR json_extract(status, '$.at') <= ?) RETURNING id`,
      JSON.stringify(status),
      id,
      status.at,
    );
    return changed !== undefined;
  }

  async markDeleting(id: AgentId) {
    await this.db.run(
      `UPDATE neo_agents SET state = 'deleting', updated_at = ? WHERE id = ?`,
      this.now(),
      id,
    );
  }

  async deleting() {
    const rows = await this.db.all<{ id: AgentId }>(
      `SELECT id FROM neo_agents WHERE state = 'deleting'`,
    );
    return rows.map((r) => r.id);
  }

  async remove(id: AgentId) {
    await this.db.run(`DELETE FROM neo_agents WHERE id = ?`, id);
  }

  private async byName(name: string) {
    return this.db.get<Row>(`SELECT * FROM neo_agents WHERE name = ?`, name);
  }

  private async freeId(name: string) {
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/^-+|-+$/g, "") || "agent";
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!(await this.row(agentId(id)))) return agentId(id);
    }
  }
}

export class RegistryError extends Error {}

function cleanText(
  key: keyof ProfileChange,
  max: number,
  value: string | null | undefined,
) {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > max)
    throw new RegistryError(`${key} is at most ${max} characters`);
  return trimmed || null;
}

function clean(input: ProfileChange) {
  const name = cleanText("name", NAME_MAX, input.name);
  const title = cleanText("title", TITLE_MAX, input.title);
  const description = cleanText(
    "description",
    DESCRIPTION_MAX,
    input.description,
  );
  const instructions = cleanText(
    "instructions",
    INSTRUCTIONS_MAX,
    input.instructions,
  );
  return {
    ...(name !== undefined ? { name: name ?? "" } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

function toProfile(row: Row) {
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
