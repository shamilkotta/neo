import { AgentProfile, agentId, parseJson } from "@neo/client";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
export type { AgentProfile } from "@neo/client";

export const AGENT_SCHEMA = async (tx: SqliteExecutor) => {
  await tx.exec(`CREATE TABLE neo_agent (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    conversation_id INTEGER,
    paused INTEGER NOT NULL DEFAULT 0
  ) STRICT`);
};

export const PRIMARY_AGENT_ID = agentId("neo");

export interface Self {
  profile: AgentProfile;
  conversationId: number | null;
  paused: boolean;
}

interface Row {
  id: string;
  profile: string;
  conversation_id: number | null;
  paused: number;
}

export class AgentSelf {
  private cache: Self | undefined;

  constructor(private readonly db: SqliteDatabase) {}

  async init(profile: AgentProfile) {
    await this.db.run(
      `INSERT INTO neo_agent (id, profile) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile`,
      profile.id,
      JSON.stringify(profile),
    );
    this.cache = undefined;
  }

  async get() {
    if (this.cache) return this.cache;
    const row = await this.db.get<Row>(`SELECT * FROM neo_agent LIMIT 1`);
    if (!row) throw new Error("This agent has no record");
    this.cache = {
      profile: parseJson(AgentProfile, row.profile),
      conversationId: row.conversation_id,
      paused: row.paused === 1,
    };
    return this.cache;
  }

  async setProfile(profile: AgentProfile) {
    await this.db.run(
      `UPDATE neo_agent SET profile = ?`,
      JSON.stringify(profile),
    );
    this.cache = undefined;
  }

  async setConversation(conversationId: number) {
    await this.db.run(
      `UPDATE neo_agent SET conversation_id = ?`,
      conversationId,
    );
    this.cache = undefined;
  }

  async setPaused(paused: boolean) {
    await this.db.run(`UPDATE neo_agent SET paused = ?`, paused ? 1 : 0);
    this.cache = undefined;
  }
}
