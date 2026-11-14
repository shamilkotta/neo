import { present } from "../errors";
import { Type, type Static } from "typebox";
import { ulid } from "../ids";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import {
  MemoryKind,
  MemoryOrigin,
  MemoryOwnerKind,
  Memory,
  parseJson,
} from "@neo/client";
export type {
  MemoryKind,
  MemoryOrigin,
  MemoryOwnerKind,
  Memory,
} from "@neo/client";

export const MEMORY_SCHEMA = async (tx: SqliteExecutor) => {
  await tx.exec(`CREATE TABLE neo_memories (
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL DEFAULT 'agent',
    kind TEXT NOT NULL CHECK (kind IN ('essential', 'searchable')),
    origin TEXT NOT NULL DEFAULT 'automatic',
    user_controlled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await tx.exec(
    `CREATE INDEX neo_memories_by_agent ON neo_memories (owner_kind, kind, id)`,
  );
  await tx.exec(
    `CREATE VIRTUAL TABLE neo_memories_fts USING fts5(text, content='neo_memories', content_rowid='rowid')`,
  );
  await tx.exec(`CREATE TRIGGER neo_memories_ai AFTER INSERT ON neo_memories BEGIN
    INSERT INTO neo_memories_fts(rowid, text) VALUES (new.rowid, new.text);
  END`);
  await tx.exec(`CREATE TRIGGER neo_memories_ad AFTER DELETE ON neo_memories BEGIN
    INSERT INTO neo_memories_fts(neo_memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END`);
  await tx.exec(`CREATE TRIGGER neo_memories_au AFTER UPDATE ON neo_memories BEGIN
    INSERT INTO neo_memories_fts(neo_memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO neo_memories_fts(rowid, text) VALUES (new.rowid, new.text);
  END`);
  await tx.exec(`CREATE TABLE neo_memory_staged (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    call_id TEXT NOT NULL UNIQUE,
    op TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`);
  await tx.exec(
    `CREATE INDEX neo_memory_staged_by_request ON neo_memory_staged (request_id, seq)`,
  );
};

export const MEMORY_TEXT_LIMIT = 500;
export const ESSENTIAL_BUDGET_BYTES = 8192;
export const MEMORY_LIMIT = 128;
export const OWNER_LIMITS: Record<Exclude<MemoryOwnerKind, "agent">, number> = {
  channel: 32,
  connection: 32,
};
const LIST_PAGE = 20;

interface MemoryRow {
  id: string;
  owner_kind: MemoryOwnerKind;
  kind: MemoryKind;
  origin: MemoryOrigin;
  user_controlled: number;
  revision: number;
  text: string;
  created_at: number;
  updated_at: number;
}

const StagedOp = Type.Union([
  Type.Object({
    type: Type.Literal("remember"),
    text: Type.String(),
    memoryId: Type.Optional(Type.String()),
    inclusion: MemoryKind,
    newId: Type.String(),
  }),
  Type.Object({ type: Type.Literal("forget"), memoryId: Type.String() }),
  Type.Object({
    type: Type.Literal("selection"),
    changes: Type.Array(
      Type.Object({
        memoryId: Type.String(),
        inclusion: MemoryKind,
        expectedRevision: Type.Number(),
      }),
    ),
  }),
]);
export type StagedOp = Static<typeof StagedOp>;

export class MemoryError extends Error {}

export function serializeEssential(
  memories: Pick<Memory, "id" | "text" | "origin">[],
) {
  const entries = memories.map(({ id, text, origin }) => ({
    id,
    text,
    origin,
  }));
  return `<agent_memories count="${entries.length}">\n${JSON.stringify(entries)}\n</agent_memories>`;
}

const bytes = (memories: Pick<Memory, "id" | "text" | "origin">[]) =>
  new TextEncoder().encode(serializeEssential(memories)).byteLength;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export class Memories {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async add(
    text: string,
    kind: MemoryKind = "searchable",
    id: string = ulid(this.now()),
    options: { origin?: MemoryOrigin; ownerKind?: MemoryOwnerKind } = {},
  ) {
    const existing = await this.get(id);
    if (existing) return existing;
    const value = normalize(text);
    if (!value) throw new MemoryError("A memory needs text");
    if (value.length > MEMORY_TEXT_LIMIT)
      throw new MemoryError(
        `A memory is at most ${MEMORY_TEXT_LIMIT} characters`,
      );
    const ownerKind = options.ownerKind ?? "agent";
    const count = await this.count(ownerKind);
    const limit =
      ownerKind === "agent" ? MEMORY_LIMIT : OWNER_LIMITS[ownerKind];
    if (count >= limit)
      throw new MemoryError(
        `The memory limit is reached (${count} of ${limit}); forget one first`,
      );
    const origin = options.origin ?? "manual";
    let inclusion = kind;
    if (inclusion === "essential") {
      const essential = await this.list("essential", ownerKind);
      if (
        bytes([...essential, { id, text: value, origin }]) >
        ESSENTIAL_BUDGET_BYTES
      )
        inclusion = "searchable";
    }
    const time = this.now();
    await this.db.run(
      `INSERT INTO neo_memories (id, owner_kind, kind, origin, user_controlled, revision, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      id,
      ownerKind,
      inclusion,
      origin,
      origin === "manual" && kind === "essential" ? 1 : 0,
      value,
      time,
      time,
    );
    return present(await this.get(id), `memory ${id}`);
  }

  async get(id: string) {
    const row = await this.db.get<MemoryRow>(
      `SELECT * FROM neo_memories WHERE id = ?`,
      id,
    );
    return row ? toMemory(row) : undefined;
  }

  async list(kind?: MemoryKind, ownerKind: MemoryOwnerKind = "agent") {
    const rows = kind
      ? await this.db.all<MemoryRow>(
          `SELECT * FROM neo_memories WHERE owner_kind = ? AND kind = ? ORDER BY id`,
          ownerKind,
          kind,
        )
      : await this.db.all<MemoryRow>(
          `SELECT * FROM neo_memories WHERE owner_kind = ? ORDER BY id`,
          ownerKind,
        );
    return rows.map(toMemory);
  }

  async count(ownerKind: MemoryOwnerKind = "agent") {
    return (
      (
        await this.db.get<{ n: number }>(
          `SELECT count(*) AS n FROM neo_memories WHERE owner_kind = ?`,
          ownerKind,
        )
      )?.n ?? 0
    );
  }

  async update(id: string, change: { text?: string; kind?: MemoryKind }) {
    const current = await this.get(id);
    if (!current) return undefined;
    const text =
      change.text !== undefined ? normalize(change.text) : current.text;
    if (!text || text.length > MEMORY_TEXT_LIMIT)
      throw new MemoryError(
        `A memory has 1 to ${MEMORY_TEXT_LIMIT} characters`,
      );
    if (change.kind === "essential" && current.kind !== "essential") {
      const others = (await this.list("essential", current.ownerKind)).filter(
        (m) => m.id !== id,
      );
      if (bytes([...others, { ...current, text }]) > ESSENTIAL_BUDGET_BYTES)
        throw new MemoryError("The essential memories are over their budget");
    }
    await this.db.run(
      `UPDATE neo_memories SET text = ?, kind = ?, origin = ?, user_controlled = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      text,
      change.kind ?? current.kind,
      change.text !== undefined ? "manual" : current.origin,
      change.kind !== undefined ? 1 : current.userControlled ? 1 : 0,
      this.now(),
      id,
    );
    return this.get(id);
  }

  async remove(id: string) {
    const current = await this.get(id);
    if (!current) return false;
    await this.db.run(`DELETE FROM neo_memories WHERE id = ?`, id);
    return true;
  }

  async clear(ownerKind: MemoryOwnerKind = "agent") {
    const n = await this.count(ownerKind);
    await this.db.run(
      `DELETE FROM neo_memories WHERE owner_kind = ?`,
      ownerKind,
    );
    return n;
  }

  async search(query: string, limit = 8, ownerKind: MemoryOwnerKind = "agent") {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"*`);
    if (terms.length === 0) return [];
    const rows = await this.db.all<MemoryRow>(
      `SELECT m.* FROM neo_memories_fts f JOIN neo_memories m ON m.rowid = f.rowid
       WHERE neo_memories_fts MATCH ? AND m.owner_kind = ? ORDER BY f.rank LIMIT ?`,
      terms.join(" OR "),
      ownerKind,
      Math.min(Math.max(1, limit), 25),
    );
    return rows.map(toMemory);
  }

  async page(
    after: string | null,
  ): Promise<{ memories: Memory[]; nextCursor: string | null }> {
    const rows = await this.db.all<MemoryRow>(
      `SELECT * FROM neo_memories WHERE owner_kind = 'agent' AND id > ? ORDER BY id LIMIT ?`,
      after ?? "",
      LIST_PAGE + 1,
    );
    const memories = rows.slice(0, LIST_PAGE).map(toMemory);
    return {
      memories,
      nextCursor:
        rows.length > LIST_PAGE ? (memories.at(-1)?.id ?? null) : null,
    };
  }

  private async projected(requestId: string) {
    const all = new Map((await this.list()).map((m) => [m.id, m]));
    for (const op of await this.stagedOps(requestId)) {
      if (op.type === "remember") {
        const target = op.memoryId ?? op.newId;
        const current: Memory = all.get(target) ?? {
          id: target,
          ownerKind: "agent",
          kind: op.inclusion,
          origin: "automatic",
          userControlled: false,
          revision: 0,
          text: op.text,
          createdAt: 0,
          updatedAt: 0,
        };
        all.set(target, { ...current, text: op.text, kind: op.inclusion });
      } else if (op.type === "forget") all.delete(op.memoryId);
      else
        for (const c of op.changes) {
          const m = all.get(c.memoryId);
          if (m) all.set(m.id, { ...m, kind: c.inclusion });
        }
    }
    return all;
  }

  private async stagedOps(requestId: string) {
    const rows = await this.db.all<{ op: string }>(
      `SELECT op FROM neo_memory_staged WHERE request_id = ? ORDER BY seq`,
      requestId,
    );
    return rows.map((r) => parseJson(StagedOp, r.op));
  }

  private async stage(requestId: string, callId: string, op: StagedOp) {
    await this.db.run(
      `INSERT INTO neo_memory_staged (request_id, call_id, op, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(call_id) DO NOTHING`,
      requestId,
      callId,
      JSON.stringify(op),
      this.now(),
    );
  }

  async stageRemember(
    requestId: string,
    callId: string,
    input: { text: string; memoryId?: string; inclusion?: MemoryKind },
  ) {
    const text = normalize(input.text);
    if (!text) throw new MemoryError("A memory needs text");
    if (text.length > MEMORY_TEXT_LIMIT)
      throw new MemoryError(
        `A memory is at most ${MEMORY_TEXT_LIMIT} characters`,
      );
    const current = input.memoryId ? await this.get(input.memoryId) : undefined;
    if (input.memoryId && (!current || current.ownerKind !== "agent"))
      throw new MemoryError(
        `No memory has the id "${input.memoryId}"; nothing was saved. Ids come only from search_memories or list_memories. To save a new memory, call remember again without memoryId.`,
      );
    if (
      current?.userControlled &&
      input.inclusion &&
      input.inclusion !== current.kind
    )
      throw new MemoryError(
        "The person chose this memory's inclusion; it cannot be changed.",
      );
    const planned = await this.projected(requestId);
    const duplicate = [...planned.values()].find(
      (m) => m.id !== input.memoryId && m.text === text,
    );
    if (duplicate && !input.memoryId)
      return {
        status: "unchanged",
        memoryId: duplicate.id,
        inclusion: duplicate.kind,
      };
    const intended: MemoryKind =
      input.inclusion ??
      (current?.userControlled
        ? current.kind
        : (current?.kind ?? "searchable"));
    let inclusion = intended;
    if (inclusion === "essential") {
      const others = [...planned.values()].filter(
        (m) => m.kind === "essential" && m.id !== input.memoryId,
      );
      if (
        bytes([
          ...others,
          { id: input.memoryId ?? "new", text, origin: "automatic" },
        ]) > ESSENTIAL_BUDGET_BYTES
      ) {
        if (current?.kind === "essential")
          throw new MemoryError("The essential memories are over their budget");
        inclusion = "searchable";
      }
    }
    if (!input.memoryId) {
      if (planned.size >= MEMORY_LIMIT)
        throw new MemoryError(
          `The memory limit is reached (${planned.size} of ${MEMORY_LIMIT}). Forget or merge one first.`,
        );
    }
    await this.stage(requestId, callId, {
      type: "remember",
      text,
      ...(input.memoryId ? { memoryId: input.memoryId } : {}),
      inclusion,
      newId: ulid(this.now()),
    });
    return {
      status: "staged",
      memoryId: input.memoryId ?? null,
      inclusion,
      ...(inclusion !== intended
        ? {
            note: "The essential memories are full, so it is saved as searchable.",
          }
        : {}),
    };
  }

  async stageForget(
    requestId: string,
    callId: string,
    memoryId: string,
  ): Promise<{ status: string; memoryId: string }> {
    const current = await this.get(memoryId);
    if (!current || current.ownerKind !== "agent")
      throw new MemoryError(
        "This memory does not belong to the current agent.",
      );
    if (current.userControlled)
      throw new MemoryError(
        "The person controls this memory; only they can remove it.",
      );
    await this.stage(requestId, callId, { type: "forget", memoryId });
    return { status: "staged", memoryId };
  }

  async stageSelection(
    requestId: string,
    callId: string,
    changes: {
      memoryId: string;
      inclusion: MemoryKind;
      expectedRevision: number;
    }[],
  ): Promise<{ status: string }> {
    if (changes.length < 1 || changes.length > 25)
      throw new MemoryError(
        "Provide 1 to 25 memory selections with their current revisions.",
      );
    const planned = await this.projected(requestId);
    const seen = new Set<string>();
    for (const change of changes) {
      const memory = await this.get(change.memoryId);
      if (
        !memory ||
        memory.revision !== change.expectedRevision ||
        seen.has(change.memoryId)
      )
        throw new MemoryError(
          "A memory changed since you read it, or the revision is wrong. Read it again with search_memories or list_memories.",
        );
      if (memory.userControlled)
        throw new MemoryError("The person controls this memory's inclusion.");
      seen.add(change.memoryId);
      const p = planned.get(memory.id);
      if (p) planned.set(memory.id, { ...p, kind: change.inclusion });
    }
    const essential = [...planned.values()].filter(
      (m) => m.kind === "essential",
    );
    if (bytes(essential) > ESSENTIAL_BUDGET_BYTES)
      throw new MemoryError(
        "These choices go over the essential memory budget.",
      );
    await this.stage(requestId, callId, {
      type: "selection",
      changes,
    });
    return { status: "staged" };
  }

  async finish(requestId: string, completed: boolean) {
    const rows = await this.db.all<{ op: string }>(
      `SELECT op FROM neo_memory_staged WHERE request_id = ? ORDER BY seq`,
      requestId,
    );
    if (rows.length === 0) return 0;
    let applied = 0;
    if (completed) {
      for (const row of rows) {
        const op = parseJson(StagedOp, row.op);
        try {
          applied += await this.apply(op);
        } catch {}
      }
    }
    await this.db.run(
      `DELETE FROM neo_memory_staged WHERE request_id = ?`,
      requestId,
    );
    return applied;
  }

  private async apply(op: StagedOp) {
    const time = this.now();
    if (op.type === "remember") {
      if (op.memoryId) {
        const current = await this.get(op.memoryId);
        if (!current) return 0;
        await this.db.run(
          `UPDATE neo_memories SET text = ?, kind = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
          op.text,
          current.userControlled ? current.kind : op.inclusion,
          time,
          op.memoryId,
        );
        return 1;
      }
      const same = (await this.list()).find((m) => m.text === op.text);
      if (same) return 0;
      if ((await this.count()) >= MEMORY_LIMIT) return 0;
      await this.db.run(
        `INSERT INTO neo_memories (id, owner_kind, kind, origin, user_controlled, revision, text, created_at, updated_at)
         VALUES (?, 'agent', ?, 'automatic', 0, 0, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        op.newId,
        op.inclusion,
        op.text,
        time,
        time,
      );
      return 1;
    }
    if (op.type === "forget") {
      const current = await this.get(op.memoryId);
      if (!current || current.userControlled) return 0;
      await this.db.run(`DELETE FROM neo_memories WHERE id = ?`, op.memoryId);
      return 1;
    }
    let n = 0;
    for (const c of op.changes) {
      const current = await this.get(c.memoryId);
      if (
        !current ||
        current.userControlled ||
        current.revision !== c.expectedRevision
      )
        continue;
      await this.db.run(
        `UPDATE neo_memories SET kind = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        c.inclusion,
        time,
        c.memoryId,
      );
      n++;
    }
    return n;
  }
}

function toMemory(row: MemoryRow) {
  return {
    id: row.id,
    ownerKind: row.owner_kind ?? "agent",
    kind: row.kind,
    origin: row.origin ?? "automatic",
    userControlled: row.user_controlled === 1,
    revision: row.revision ?? 0,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
