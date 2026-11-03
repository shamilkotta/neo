import { present } from "../errors";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import { EventBody, parse, type NeoEvent, type LiveEvent } from "@neo/client";
export type { EventBody, NeoEvent, LiveEvent } from "@neo/client";

export const EVENTS_SCHEMA = async (tx: SqliteExecutor) => {
  await tx.exec(`CREATE TABLE neo_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  ) STRICT`);
};

const KEEP = 20_000;

export class Events {
  private readonly durable = new Set<(event: NeoEvent) => void>();
  private readonly ephemeral = new Set<(event: LiveEvent) => void>();
  private writes = 0;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async emit(body: EventBody) {
    const at = this.now();
    const row = await this.db.get<{ seq: number }>(
      `INSERT INTO neo_events (at, type, data) VALUES (?, ?, ?) RETURNING seq`,
      at,
      body.type,
      JSON.stringify(body.data),
    );
    const event: NeoEvent = { seq: present(row, "event").seq, at, ...body };
    for (const listener of [...this.durable]) {
      try {
        listener(event);
      } catch {}
    }
    if (++this.writes % 500 === 0)
      await this.db.run(
        `DELETE FROM neo_events WHERE seq <= ?`,
        event.seq - KEEP,
      );
    return event;
  }

  live(type: string, data: unknown) {
    if (this.ephemeral.size === 0) return;
    const event: LiveEvent = { type, data };
    for (const listener of [...this.ephemeral]) {
      try {
        listener(event);
      } catch {}
    }
  }

  async since(after: number, limit = 1000) {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_events WHERE seq > ? ORDER BY seq LIMIT ?`,
      after,
      limit,
    );
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      ...parse(EventBody, { type: r.type, data: JSON.parse(r.data) }),
    }));
  }

  async latest() {
    const row = await this.db.get<{ seq: number | null }>(
      `SELECT max(seq) AS seq FROM neo_events`,
    );
    return row?.seq ?? 0;
  }

  subscribe(listener: (event: NeoEvent) => void) {
    this.durable.add(listener);
    return () => this.durable.delete(listener);
  }

  subscribeLive(listener: (event: LiveEvent) => void) {
    this.ephemeral.add(listener);
    return () => this.ephemeral.delete(listener);
  }

  stream(after: number, signal: AbortSignal) {
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
          write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        };
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
  data: string;
}
