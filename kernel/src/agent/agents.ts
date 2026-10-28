import type { ModelRef } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type { ThinkingLevel, HeartbeatConfig, AgentRecord, AgentChange } from "@neo/client";
export type { ThinkingLevel, HeartbeatConfig, AgentRecord, AgentChange } from "@neo/client";

export const AGENTS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    model_provider TEXT,
    model_id TEXT,
    thinking TEXT,
    conversation_id INTEGER UNIQUE,
    paused INTEGER NOT NULL DEFAULT 0,
    heartbeat TEXT NOT NULL DEFAULT '{}',
    heartbeat_next_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`);
};

/** The one agent of this iteration. Rows are keyed by id so more agents need no migration. */
export const DEFAULT_AGENT_ID = "neo";

export const HEARTBEAT_DEFAULTS: HeartbeatConfig = {
  enabled: false,
  everyMinutes: 30,
};

interface Row {
  id: string;
  name: string;
  instructions: string;
  model_provider: string | null;
  model_id: string | null;
  thinking: ThinkingLevel | null;
  conversation_id: number | null;
  paused: number;
  heartbeat: string;
  heartbeat_next_at: number | null;
  created_at: number;
  updated_at: number;
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class Agents {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number,
  ) {}

  /** Creates the default agent on a new instance. */
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
    const row = await this.db.get<Row>(`SELECT * FROM neo_agents WHERE id = ?`, id);
    if (!row) throw new Error(`No agent ${id}`);
    return toRecord(row);
  }

  async list(): Promise<AgentRecord[]> {
    const rows = await this.db.all<Row>(`SELECT * FROM neo_agents ORDER BY created_at`);
    return rows.map(toRecord);
  }

  async update(id: string, change: AgentChange): Promise<AgentRecord> {
    const current = await this.get(id);
    if (change.name !== undefined && !change.name.trim()) throw new Error("name is empty");
    if (change.name !== undefined && change.name.length > 60) throw new Error("name is too long");
    if (change.instructions !== undefined && change.instructions.length > 20_000)
      throw new Error("instructions are too long (20000 characters)");
    if (change.thinking && !THINKING.includes(change.thinking))
      throw new Error(`thinking is one of ${THINKING.join(", ")}`);
    const heartbeat = change.heartbeat
      ? validateHeartbeat({ ...current.heartbeat, ...change.heartbeat })
      : current.heartbeat;
    const model = change.model === undefined ? current.model : change.model;
    await this.db.run(
      `UPDATE neo_agents SET name = ?, instructions = ?, model_provider = ?, model_id = ?, thinking = ?, heartbeat = ?, updated_at = ? WHERE id = ?`,
      change.name?.trim() ?? current.name,
      change.instructions ?? current.instructions,
      model?.provider ?? null,
      model?.modelId ?? null,
      change.thinking === undefined ? current.thinking : change.thinking,
      JSON.stringify(heartbeat),
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

  async setHeartbeatNext(id: string, at: number | null): Promise<void> {
    await this.db.run(`UPDATE neo_agents SET heartbeat_next_at = ? WHERE id = ?`, at, id);
  }
}

function validateHeartbeat(config: HeartbeatConfig): HeartbeatConfig {
  if (typeof config.enabled !== "boolean") throw new Error("heartbeat.enabled is true or false");
  if (!Number.isInteger(config.everyMinutes) || config.everyMinutes < 5 || config.everyMinutes > 24 * 60)
    throw new Error("heartbeat.everyMinutes is a whole number from 5 to 1440");
  if (config.activeHours) {
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hhmm.test(config.activeHours.start) || !hhmm.test(config.activeHours.end))
      throw new Error("heartbeat.activeHours are HH:MM");
  }
  if (config.prompt !== undefined && config.prompt.length > 4_000)
    throw new Error("heartbeat.prompt is too long (4000 characters)");
  return {
    enabled: config.enabled,
    everyMinutes: config.everyMinutes,
    ...(config.activeHours ? { activeHours: config.activeHours } : {}),
    ...(config.prompt?.trim() ? { prompt: config.prompt.trim() } : {}),
  };
}

function toRecord(row: Row): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    model:
      row.model_provider && row.model_id
        ? { provider: row.model_provider, modelId: row.model_id }
        : null,
    thinking: row.thinking,
    conversationId: row.conversation_id,
    paused: row.paused === 1,
    heartbeat: { ...HEARTBEAT_DEFAULTS, ...(JSON.parse(row.heartbeat) as Partial<HeartbeatConfig>) },
    heartbeatNextAt: row.heartbeat_next_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
