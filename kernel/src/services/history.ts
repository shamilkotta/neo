import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { INPUT_ENTRY, type InputEntryData } from "../agent/mailbox";
import type { SqliteDatabase, SqliteExecutor } from "../sql";

export const HISTORY_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  // The conversation's messages as text, indexed for search. Derived from Pi's transcript (an
  // export can drop it; `sync` rebuilds it), so searching never loads the transcript into memory.
  await tx.exec(`CREATE TABLE neo_history (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    entry_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    UNIQUE (agent_id, entry_id)
  ) STRICT`);
  await tx.exec(
    `CREATE VIRTUAL TABLE neo_history_fts USING fts5(text, content='neo_history', content_rowid='id', tokenize='unicode61')`,
  );
  await tx.exec(`CREATE TRIGGER neo_history_ai AFTER INSERT ON neo_history BEGIN
    INSERT INTO neo_history_fts(rowid, text) VALUES (new.id, new.text);
  END`);
  await tx.exec(`CREATE TRIGGER neo_history_ad AFTER DELETE ON neo_history BEGIN
    INSERT INTO neo_history_fts(neo_history_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END`);
};

/** One message of the history: what the person or the agent said, and the tools a reply called. */
export interface HistoryLine {
  messageId: number;
  role: "user" | "assistant";
  text: string;
  steps: string[];
}

interface Row {
  entry_id: number;
  role: "user" | "assistant";
  text: string;
  steps: string;
}

/** Entries read from Pi per page while catching up: memory stays at one page. */
const SYNC_PAGE = 200;

export function lineOf(entry: EntryRecord): HistoryLine | undefined {
  // A turn's input: the messages as they were sent, not the combined prompt.
  if (entry.kind === INPUT_ENTRY) {
    const data = entry.data as InputEntryData | undefined;
    const text = (data?.messages ?? []).map((m) => m.text).join("\n\n");
    if (!text.trim()) return undefined;
    return { messageId: entry.id as unknown as number, role: "user", text, steps: [] };
  }
  const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
  if (!message || message.role !== "assistant") return undefined;
  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : ((message.content as { type: string; text?: string; name?: string; arguments?: unknown }[]) ?? []);
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  // Work steps: the tools called, never raw reasoning.
  const steps = parts
    .filter((p) => p.type === "toolCall")
    .map((p) => `${p.name}(${JSON.stringify(p.arguments ?? {}).slice(0, 200)})`);
  if (!text.trim() && steps.length === 0) return undefined;
  return { messageId: entry.id as unknown as number, role: "assistant", text, steps };
}

/**
 * The searchable history of each agent's conversation, across resets and compactions (the model
 * may no longer see older messages; they stay in storage, and this finds them).
 */
export class History {
  /** One catch-up at a time per agent. */
  private readonly syncing = new Map<string, Promise<void>>();

  constructor(private readonly db: SqliteDatabase) {}

  /** Indexes entries newer than the last indexed one, a page at a time. */
  sync(agentId: string, conversation: Conversation): Promise<void> {
    const running = this.syncing.get(agentId);
    if (running) return running;
    const run = this.catchUp(agentId, conversation).finally(() => this.syncing.delete(agentId));
    this.syncing.set(agentId, run);
    return run;
  }

  private async catchUp(agentId: string, conversation: Conversation): Promise<void> {
    const last = await this.db.get<{ id: number | null }>(
      `SELECT max(entry_id) AS id FROM neo_history WHERE agent_id = ?`,
      agentId,
    );
    let cursor: Parameters<Conversation["entries"]>[2];
    for (;;) {
      const page = await conversation.entries(
        { order: "ascending", ...(last?.id ? { minEntryId: (last.id + 1) as never } : {}) },
        SYNC_PAGE,
        cursor,
        BACKGROUND_CONTEXT,
      );
      const lines = page.items.map(lineOf).filter((l): l is HistoryLine => l !== undefined);
      if (lines.length)
        await this.db.transaction(async (tx) => {
          for (const line of lines)
            await tx.run(
              `INSERT INTO neo_history (agent_id, entry_id, role, text, steps) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              agentId,
              line.messageId,
              line.role,
              line.text,
              JSON.stringify(line.steps),
            );
        });
      if (!page.next || page.items.length === 0) return;
      cursor = page.next;
    }
  }

  /** Messages with every term (prefix match), newest first, before `before`. */
  async search(
    agentId: string,
    query: string,
    options: { before?: number; limit?: number } = {},
  ): Promise<(Pick<HistoryLine, "messageId" | "role"> & { excerpt: string; length: number })[]> {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map((t) => `"${t}"*`);
    if (terms.length === 0) return [];
    const rows = await this.db.all<{ entry_id: number; role: "user" | "assistant"; excerpt: string; length: number }>(
      `SELECT h.entry_id, h.role, length(h.text) AS length,
              snippet(neo_history_fts, 0, '', '', '…', 48) AS excerpt
       FROM neo_history_fts JOIN neo_history h ON h.id = neo_history_fts.rowid
       WHERE neo_history_fts MATCH ? AND h.agent_id = ? AND h.entry_id < ?
       ORDER BY h.entry_id DESC LIMIT ?`,
      terms.join(" AND "),
      agentId,
      options.before ?? Number.MAX_SAFE_INTEGER,
      Math.min(Math.max(options.limit ?? 8, 1), 20),
    );
    return rows.map((r) => ({ messageId: r.entry_id, role: r.role, excerpt: r.excerpt, length: r.length }));
  }

  async message(agentId: string, messageId: number): Promise<HistoryLine | undefined> {
    const row = await this.db.get<Row>(
      `SELECT entry_id, role, text, steps FROM neo_history WHERE agent_id = ? AND entry_id = ?`,
      agentId,
      messageId,
    );
    return row ? toLine(row) : undefined;
  }

  /** A page of messages before `before`, oldest first, and the cursor for the page before it. */
  async page(agentId: string, before: number | undefined, limit: number): Promise<{ lines: HistoryLine[]; before: number | null }> {
    const rows = await this.db.all<Row>(
      `SELECT entry_id, role, text, steps FROM neo_history WHERE agent_id = ? AND entry_id < ? ORDER BY entry_id DESC LIMIT ?`,
      agentId,
      before ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    const more = rows.length > limit;
    const lines = rows.slice(0, limit).reverse().map(toLine);
    return { lines, before: more && lines.length ? lines[0]!.messageId : null };
  }
}

function toLine(row: Row): HistoryLine {
  return { messageId: row.entry_id, role: row.role, text: row.text, steps: JSON.parse(row.steps) as string[] };
}
