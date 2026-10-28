import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type { NeoEvent, LiveEvent } from "@neo/client";
export type { NeoEvent, LiveEvent } from "@neo/client";

export const EVENTS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    agent_id TEXT,
    data TEXT NOT NULL
  ) STRICT`);
};

/** Events kept for clients that reconnect with `after`; older ones are pruned. */
const KEEP = 20_000;

/**
 * Two streams on one SSE connection:
 * - durable events (`emit`): what changed (a message, a turn, the queue, memory). Stored in order,
 *   so a client resumes after a disconnect, a restart, or (later) a move.
 * - live events (`live`): the running turn's deltas. A client that reconnects reads the current
 *   transcript and live snapshot instead of replaying them.
 */
export class Events {
  private readonly durable = new Set<(event: NeoEvent) => void>();
  private readonly ephemeral = new Set<(event: LiveEvent) => void>();
  private writes = 0;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async emit(
    type: string,
    data: Record<string, unknown> = {},
    agentId: string | null = null,
  ): Promise<NeoEvent> {
    const at = this.now();
    const row = await this.db.get<{ seq: number }>(
      `INSERT INTO neo_events (at, type, agent_id, data) VALUES (?, ?, ?, ?) RETURNING seq`,
      at,
      type,
      agentId,
      JSON.stringify(data),
    );
    const event: NeoEvent = { seq: row!.seq, at, type, agentId, data };
    for (const listener of [...this.durable]) {
      try {
        listener(event);
      } catch {}
    }
    if (++this.writes % 500 === 0)
      await this.db.run(`DELETE FROM neo_events WHERE seq <= ?`, event.seq - KEEP);
    return event;
  }

  live(type: string, data: unknown, agentId: string | null = null): void {
    if (this.ephemeral.size === 0) return;
    const event: LiveEvent = { type, agentId, data };
    for (const listener of [...this.ephemeral]) {
      try {
        listener(event);
      } catch {}
    }
  }

  async since(after: number, limit = 1000): Promise<NeoEvent[]> {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_events WHERE seq > ? ORDER BY seq LIMIT ?`,
      after,
      limit,
    );
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      type: r.type,
      agentId: r.agent_id,
      data: JSON.parse(r.data),
    }));
  }

  async latest(): Promise<number> {
    const row = await this.db.get<{ seq: number | null }>(
      `SELECT max(seq) AS seq FROM neo_events`,
    );
    return row?.seq ?? 0;
  }

  subscribe(listener: (event: NeoEvent) => void): () => void {
    this.durable.add(listener);
    return () => this.durable.delete(listener);
  }

  subscribeLive(listener: (event: LiveEvent) => void): () => void {
    this.ephemeral.add(listener);
    return () => this.ephemeral.delete(listener);
  }

  /** Server-sent events: the durable backlog after `after`, then durable and live events as they happen. */
  stream(after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const cleanup: (() => void)[] = [];
    const stop = () => {
      for (const fn of cleanup.splice(0)) fn();
    };
    return new ReadableStream({
      start: async (controller) => {
        let last = after;
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            stop();
          }
        };
        const send = (event: NeoEvent) => {
          if (event.seq <= last) return;
          last = event.seq;
          write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        // Buffer what happens while the backlog is read, so nothing falls between the two.
        const pending: NeoEvent[] = [];
        const buffer = this.subscribe((e) => pending.push(e));
        for (
          let page = await this.since(after);
          page.length > 0;
          page = await this.since(last)
        )
          for (const event of page) send(event);
        buffer();
        for (const event of pending) send(event);
        cleanup.push(this.subscribe(send));
        cleanup.push(
          this.subscribeLive((e) =>
            write(`event: live\ndata: ${JSON.stringify(e)}\n\n`),
          ),
        );
        write(`: ready\n\n`);
        const ping = setInterval(() => write(`: ping\n\n`), 15_000);
        cleanup.push(() => clearInterval(ping));
        cleanup.push(() => {
          try {
            controller.close();
          } catch {}
        });
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      },
      cancel: stop,
    });
  }
}

interface Row {
  seq: number;
  at: number;
  type: string;
  agent_id: string | null;
  data: string;
}
