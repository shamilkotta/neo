import { ulid } from "../ids";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type { HeartbeatConfig } from "./agents";
import type { Wakeup } from "@neo/client";
export type { Wakeup } from "@neo/client";

export const WAKEUPS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  // Times the agent asked to be woken, with a note to itself (OpenBot's waits, on a clock).
  await tx.exec(`CREATE TABLE neo_wakeups (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    note TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'cancelled')),
    created_by TEXT NOT NULL,
    origin_key TEXT UNIQUE,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    fired_at INTEGER
  ) STRICT`);
  await tx.exec(`CREATE INDEX neo_wakeups_due ON neo_wakeups (status, at)`);
};

interface Row {
  id: string;
  agent_id: string;
  at: number;
  note: string;
  status: Wakeup["status"];
  created_by: Wakeup["createdBy"];
  message_id: string | null;
  created_at: number;
  fired_at: number | null;
}

export const WAKEUP_LIMIT = 50;
const MAX_AHEAD = 366 * 24 * 60 * 60_000;

export class WakeupError extends Error {}

export class Wakeups {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number,
  ) {}

  /**
   * Schedules a wake-up. `originKey` (a tool call's task id) makes a replayed call schedule once.
   */
  async add(
    agentId: string,
    at: number,
    note: string,
    createdBy: Wakeup["createdBy"],
    originKey?: string,
  ): Promise<Wakeup> {
    const text = note.trim();
    if (!text) throw new WakeupError("The note is empty");
    if (text.length > 2_000) throw new WakeupError("The note is too long (2000 characters)");
    if (!Number.isFinite(at)) throw new WakeupError("The time is not valid");
    const time = this.now();
    if (at < time - 60_000) throw new WakeupError("That time has passed");
    if (at > time + MAX_AHEAD) throw new WakeupError("A wake-up is at most a year ahead");
    if (originKey) {
      const existing = await this.db.get<Row>(
        `SELECT * FROM neo_wakeups WHERE origin_key = ?`,
        originKey,
      );
      if (existing) return toWakeup(existing);
    }
    const pending = await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM neo_wakeups WHERE agent_id = ? AND status = 'pending'`,
      agentId,
    );
    if ((pending?.n ?? 0) >= WAKEUP_LIMIT)
      throw new WakeupError(`At most ${WAKEUP_LIMIT} wake-ups can wait; cancel some first`);
    const row = await this.db.get<Row>(
      `INSERT INTO neo_wakeups (id, agent_id, at, note, status, created_by, origin_key, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING *`,
      ulid(time),
      agentId,
      Math.max(at, time),
      text,
      createdBy,
      originKey ?? null,
      time,
    );
    return toWakeup(row!);
  }

  async list(agentId: string, status: Wakeup["status"] | "all" = "pending"): Promise<Wakeup[]> {
    const rows =
      status === "all"
        ? await this.db.all<Row>(
            `SELECT * FROM neo_wakeups WHERE agent_id = ? ORDER BY at DESC LIMIT 200`,
            agentId,
          )
        : await this.db.all<Row>(
            `SELECT * FROM neo_wakeups WHERE agent_id = ? AND status = ? ORDER BY at LIMIT 200`,
            agentId,
            status,
          );
    return rows.map(toWakeup);
  }

  async cancel(agentId: string, id: string): Promise<boolean> {
    const row = await this.db.get(
      `UPDATE neo_wakeups SET status = 'cancelled' WHERE id = ? AND agent_id = ? AND status = 'pending' RETURNING id`,
      id,
      agentId,
    );
    return row !== undefined;
  }

  /** The earliest pending wake-up of any agent. */
  async next(): Promise<number | undefined> {
    const row = await this.db.get<{ at: number | null }>(
      `SELECT min(at) AS at FROM neo_wakeups WHERE status = 'pending'`,
    );
    return row?.at ?? undefined;
  }

  async due(): Promise<Wakeup[]> {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_wakeups WHERE status = 'pending' AND at <= ? ORDER BY at LIMIT 100`,
      this.now(),
    );
    return rows.map(toWakeup);
  }

  async markFired(id: string, messageId: string): Promise<void> {
    await this.db.run(
      `UPDATE neo_wakeups SET status = 'fired', message_id = ?, fired_at = ? WHERE id = ? AND status = 'pending'`,
      messageId,
      this.now(),
      id,
    );
  }
}

/** Parses a wake-up time: an ISO time (with an offset, or in `timezone`), or minutes from now. */
export function wakeupTime(
  input: { at?: string; inMinutes?: number },
  now: number,
  timezone: string,
): number {
  if (input.inMinutes !== undefined) {
    if (!(input.inMinutes > 0)) throw new WakeupError("inMinutes is more than 0");
    return now + Math.round(input.inMinutes * 60_000);
  }
  if (!input.at) throw new WakeupError("Give at (a time) or inMinutes");
  const text = input.at.trim();
  // With a zone (Z or +05:30): an exact instant.
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(text)) {
    const at = Date.parse(text);
    if (Number.isNaN(at)) throw new WakeupError(`Not a time: ${text}`);
    return at;
  }
  // A local wall time in the person's timezone.
  const match = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(text);
  if (!match) throw new WakeupError("at is like 2026-10-29T09:00 (the person's time) or has an offset");
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  return zonedToUtc(y!, mo!, d!, h!, mi!, s ?? 0, timezone);
}

/** A wall time in `timezone` as epoch milliseconds (two passes settle a DST edge). */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timezone: string,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - offsetAt(guess, timezone);
  return guess;
}

function offsetAt(at: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Minutes since midnight of `at` in `timezone`. */
function minutesOfDay(at: number, timezone: string): number {
  const [h, m] = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .split(":")
    .map(Number);
  return h! * 60 + m!;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Whether `at` falls in the heartbeat's active hours. */
export function inActiveHours(config: HeartbeatConfig, at: number, timezone: string): boolean {
  if (!config.activeHours) return true;
  const now = minutesOfDay(at, timezone);
  const start = toMinutes(config.activeHours.start);
  const end = toMinutes(config.activeHours.end);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * When the next heartbeat is due after `from`: one interval on, moved to the start of the active
 * hours when it would fall outside them (checked in 5-minute steps, at most a day ahead).
 */
export function nextHeartbeat(config: HeartbeatConfig, from: number, timezone: string): number {
  let at = from + config.everyMinutes * 60_000;
  for (let i = 0; i < 24 * 12 && !inActiveHours(config, at, timezone); i++) at += 5 * 60_000;
  return at;
}

export const HEARTBEAT_PROMPT = `This is your periodic heartbeat; nobody sent a message.
Look at what you know: your memories, your pending wake-ups, files you keep for yourself (for example /notes), and anything you promised to follow up on.
If something needs doing now, do it, and say briefly what you did or what the person should know.
If nothing needs attention, reply with exactly ${"HEARTBEAT_OK"} and nothing else; that reply is not shown to the person.`;

function toWakeup(row: Row): Wakeup {
  return {
    id: row.id,
    agentId: row.agent_id,
    at: row.at,
    note: row.note,
    status: row.status,
    createdBy: row.created_by,
    messageId: row.message_id,
    createdAt: row.created_at,
    firedAt: row.fired_at,
  };
}
