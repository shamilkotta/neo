import type { ModelRef } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type { ThinkingLevel, AgentRecord, AgentChange } from "@neo/client";
export type { ThinkingLevel, AgentRecord, AgentChange } from "@neo/client";

export const AGENTS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model_provider TEXT,
    model_id TEXT,
    thinking TEXT,
    conversation_id INTEGER UNIQUE,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`);
};

export const DEFAULT_AGENT_ID = "neo";

interface Row {
  id: string;
  name: string;
  model_provider: string | null;
  model_id: string | null;
  thinking: ThinkingLevel | null;
  conversation_id: number | null;
  paused: number;
  created_at: number;
  updated_at: number;
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class Agents {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number,
  ) {}

  async ensure(id = DEFAULT_AGENT_ID, name = "Neo"): Promise<AgentRecord> {
    const time = this.now();
    await this.db.run(
      `INSERT INTO neo_agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      id,
      name,
      time,
      time,
    );
    return this.get(id);
  }

  async get(id = DEFAULT_AGENT_ID): Promise<AgentRecord> {
    const row = await this.db.get<Row>(
      `SELECT * FROM neo_agents WHERE id = ?`,
      id,
    );
    if (!row) throw new Error(`No agent ${id}`);
    return toRecord(row);
  }

  async list(): Promise<AgentRecord[]> {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_agents ORDER BY created_at`,
    );
    return rows.map(toRecord);
  }

  async update(id: string, change: AgentChange): Promise<AgentRecord> {
    const current = await this.get(id);
    if (change.name !== undefined && !change.name.trim())
      throw new Error("name is empty");
    if (change.name !== undefined && change.name.length > 60)
      throw new Error("name is too long");
    if (change.thinking && !THINKING.includes(change.thinking))
      throw new Error(`thinking is one of ${THINKING.join(", ")}`);
    const model = change.model === undefined ? current.model : change.model;
    await this.db.run(
      `UPDATE neo_agents SET name = ?, model_provider = ?, model_id = ?, thinking = ?, updated_at = ? WHERE id = ?`,
      change.name?.trim() ?? current.name,
      model?.provider ?? null,
      model?.modelId ?? null,
      change.thinking === undefined ? current.thinking : change.thinking,
      this.now(),
      id,
    );
    return this.get(id);
  }

  async setConversation(id: string, conversationId: number): Promise<void> {
    await this.db.run(
      `UPDATE neo_agents SET conversation_id = ? WHERE id = ?`,
      conversationId,
      id,
    );
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    await this.db.run(
      `UPDATE neo_agents SET paused = ?, updated_at = ? WHERE id = ?`,
      paused ? 1 : 0,
      this.now(),
      id,
    );
  }
}

function toRecord(row: Row): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    model:
      row.model_provider && row.model_id
        ? { provider: row.model_provider, modelId: row.model_id }
        : null,
    thinking: row.thinking,
    conversationId: row.conversation_id,
    paused: row.paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
