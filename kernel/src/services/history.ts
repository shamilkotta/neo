import { Type } from "typebox";
import { parse, parseJson } from "@neo/client";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { INPUT_ENTRY, InputEntryData } from "../agent/mailbox";
import { isEntryId } from "../pi-ids";
import type { SqliteDatabase, SqliteExecutor } from "../sql";

export const HISTORY_SCHEMA = async (tx: SqliteExecutor) => {
  await tx.exec(`CREATE TABLE neo_history (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    UNIQUE (entry_id)
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

const SYNC_PAGE = 200;

export function lineOf(entry: EntryRecord): HistoryLine | undefined {
  if (entry.kind === INPUT_ENTRY) {
    const text = parse(InputEntryData, entry.data)
      .messages.map((m) =>
        [m.text, ...m.attachments.map((f) => `[attached ${f.name}]`)]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    if (!text.trim()) return undefined;
    return {
      messageId: entry.id,
      role: "user",
      text,
      steps: [],
    };
  }
  const message = entry.model?.[0];
  if (message?.role !== "assistant") return undefined;
  const parts = message.content;
  const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const steps = parts.flatMap((p) =>
    p.type === "toolCall"
      ? [`${p.name}(${JSON.stringify(p.arguments).slice(0, 200)})`]
      : [],
  );
  if (!text.trim() && steps.length === 0) return undefined;
  return {
    messageId: entry.id,
    role: "assistant",
    text,
    steps,
  };
}

export class History {
  private syncing: Promise<void> | undefined;

  constructor(private readonly db: SqliteDatabase) {}

  sync(conversation: Conversation) {
    this.syncing ??= this.catchUp(conversation).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async catchUp(conversation: Conversation) {
    const last = await this.db.get<{ id: number | null }>(
      `SELECT max(entry_id) AS id FROM neo_history`,
    );
    const next = last?.id ? last.id + 1 : undefined;
    let cursor: Parameters<Conversation["entries"]>[2];
    for (;;) {
      const page = await conversation.entries(
        {
          order: "ascending",
          ...(next !== undefined && isEntryId(next)
            ? { minEntryId: next }
            : {}),
        },
        SYNC_PAGE,
        cursor,
        BACKGROUND_CONTEXT,
      );
      const lines = page.items
        .map(lineOf)
        .filter((l): l is HistoryLine => l !== undefined);
      if (lines.length)
        await this.db.transaction(async (tx) => {
          for (const line of lines)
            await tx.run(
              `INSERT INTO neo_history (entry_id, role, text, steps) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
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

  async search(
    query: string,
    options: { before?: number; limit?: number } = {},
  ): Promise<
    (Pick<HistoryLine, "messageId" | "role"> & {
      excerpt: string;
      length: number;
    })[]
  > {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map((t) => `"${t}"*`);
    if (terms.length === 0) return [];
    const rows = await this.db.all<{
      entry_id: number;
      role: "user" | "assistant";
      excerpt: string;
      length: number;
    }>(
      `SELECT h.entry_id, h.role, length(h.text) AS length,
              snippet(neo_history_fts, 0, '', '', '…', 48) AS excerpt
       FROM neo_history_fts JOIN neo_history h ON h.id = neo_history_fts.rowid
       WHERE neo_history_fts MATCH ? AND h.entry_id < ?
       ORDER BY h.entry_id DESC LIMIT ?`,
      terms.join(" AND "),
      options.before ?? Number.MAX_SAFE_INTEGER,
      Math.min(Math.max(options.limit ?? 8, 1), 20),
    );
    return rows.map((r) => ({
      messageId: r.entry_id,
      role: r.role,
      excerpt: r.excerpt,
      length: r.length,
    }));
  }

  async message(messageId: number) {
    const row = await this.db.get<Row>(
      `SELECT entry_id, role, text, steps FROM neo_history WHERE entry_id = ?`,
      messageId,
    );
    return row ? toLine(row) : undefined;
  }

  async page(
    before: number | undefined,
    limit: number,
  ): Promise<{ lines: HistoryLine[]; before: number | null }> {
    const rows = await this.db.all<Row>(
      `SELECT entry_id, role, text, steps FROM neo_history WHERE entry_id < ? ORDER BY entry_id DESC LIMIT ?`,
      before ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    const more = rows.length > limit;
    const lines = rows.slice(0, limit).reverse().map(toLine);
    return { lines, before: more ? (lines[0]?.messageId ?? null) : null };
  }
}

function toLine(row: Row) {
  return {
    messageId: row.entry_id,
    role: row.role,
    text: row.text,
    steps: parseJson(Type.Array(Type.String()), row.steps),
  };
}
