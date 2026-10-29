import { Cron } from "croner";
import { ulid } from "../ids";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type {
  MailboxMessage,
  Schedule,
  ScheduleInput,
  ScheduleRun,
  ScheduleSpec,
} from "@neo/client";
import type { SendInput } from "./mailbox";
export type {
  Schedule,
  ScheduleInput,
  ScheduleRun,
  ScheduleSpec,
} from "@neo/client";

export const SCHEDULES_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  // Everything that wakes an agent on a clock: one-off reminders, routines, the heartbeat.
  await tx.exec(`CREATE TABLE neo_schedules (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    spec TEXT NOT NULL,
    anchor_at INTEGER NOT NULL,
    timezone TEXT,
    window_start TEXT,
    window_end TEXT,
    when_busy TEXT NOT NULL CHECK (when_busy IN ('queue', 'skip')),
    missed TEXT NOT NULL CHECK (missed IN ('run', 'skip')),
    quiet INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    system TEXT,
    created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'person', 'system')),
    origin_key TEXT UNIQUE,
    next_at INTEGER,
    last_at INTEGER,
    last_message_id TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    max_runs INTEGER,
    ends_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (agent_id, system)
  ) STRICT`);
  await tx.exec(
    `CREATE INDEX neo_schedules_due ON neo_schedules (next_at) WHERE next_at IS NOT NULL`,
  );
  // One row per due time: what happened to it. The unique key makes a fire record once.
  await tx.exec(`CREATE TABLE neo_schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    fired_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
    reason TEXT,
    message_id TEXT,
    UNIQUE (schedule_id, due_at)
  ) STRICT`);
};

/** A turn made only of quiet schedule messages ends hidden when the answer is exactly this. */
export const QUIET_REPLY = "QUIET_OK";

export const HEARTBEAT_PROMPT = `This is your periodic heartbeat; nobody sent a message.
Look at what you know: your memories, your schedules (list_schedules), files you keep for yourself (for example /notes), and anything you promised to follow up on.
If something needs doing now, do it, and say briefly what you did or what the person should know.
If something should happen regularly, create a schedule for it instead of relying on the heartbeat.`;

/** The built-in heartbeat every agent has. On by default: this is how the agent acts on its own. */
export const HEARTBEAT: ScheduleInput = {
  name: "Heartbeat",
  prompt: HEARTBEAT_PROMPT,
  everyMinutes: 60,
  window: { start: "08:00", end: "22:00" },
  whenBusy: "skip",
  missed: "skip",
  quiet: true,
  enabled: true,
};

export const SCHEDULE_LIMIT = 100;
export const MIN_INTERVAL_MINUTES = 5;
const MAX_AHEAD = 366 * 24 * 60 * 60_000;
/** A recurring schedule with `missed: "skip"` still runs when it is at most this late. */
const GRACE_MS = 10 * 60_000;
/** Fires handled in one pass; the rest go in the next one, armed at once. */
const BATCH = 50;
/** A failed send (no model, an error) is tried again after these delays, then given up. */
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ScheduleError extends Error {}

interface Row {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  spec: string;
  anchor_at: number;
  timezone: string | null;
  window_start: string | null;
  window_end: string | null;
  when_busy: Schedule["whenBusy"];
  missed: Schedule["missed"];
  quiet: number;
  enabled: number;
  system: string | null;
  created_by: Schedule["createdBy"];
  next_at: number | null;
  last_at: number | null;
  last_message_id: string | null;
  run_count: number;
  failures: number;
  max_runs: number | null;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What firing needs from the rest of Neo. */
export interface ScheduleDelivery {
  /** Puts the message in the agent's queue (deduplicated by `clientId`); throws when it cannot (no model). */
  send(agentId: string, input: SendInput): Promise<MailboxMessage>;
  /** Not paused, no turn running, nothing queued. */
  idle(agentId: string): Promise<boolean>;
  /** The message is still waiting to start (queued). */
  waiting(messageId: string): Promise<boolean>;
  timezone(): Promise<string>;
}

/**
 * The one clock of an agent's own initiative. A reminder, a routine and the heartbeat are rows of
 * the same table, fired by the same pass:
 *
 * - The host has one alarm; `Neo.arm` sets it to `next()` (with Pi's own wake).
 * - `fire()` takes every row whose `next_at` passed, decides (send or skip, with a reason), sends
 *   the message with the clientId `schedule:<id>:<due>`, then records the run and moves `next_at`
 *   in one transaction that only applies if `next_at` is still that due time.
 * - A crash between the send and the record fires again: the clientId returns the same message
 *   and the run's unique key records it once. Nothing is lost, nothing doubles.
 * - The next time is computed from now, so a host that was down for a day fires each schedule
 *   once (or skips it, by its `missed` setting), never once per missed occurrence.
 * - All times are absolute in the database; wall-clock schedules follow the person's timezone and
 *   are recomputed when it changes. Moving the instance moves the schedules.
 */
export class Schedules {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number,
  ) {}

  // ---- reads ---------------------------------------------------------------------------------

  async get(agentId: string, id: string): Promise<Schedule | undefined> {
    const row = await this.db.get<Row>(
      `SELECT * FROM neo_schedules WHERE id = ? AND agent_id = ?`,
      id,
      agentId,
    );
    return row ? toSchedule(row) : undefined;
  }

  /** Active ones first (soonest first), then the rest, newest first. */
  async list(
    agentId: string,
    which: "active" | "all" = "all",
  ): Promise<Schedule[]> {
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_schedules WHERE agent_id = ? ${which === "active" ? "AND next_at IS NOT NULL" : ""}
       ORDER BY next_at IS NULL, next_at, updated_at DESC LIMIT 300`,
      agentId,
    );
    return rows.map(toSchedule);
  }

  /** The earliest time anything is due. */
  async next(): Promise<number | undefined> {
    const row = await this.db.get<{ at: number | null }>(
      `SELECT min(next_at) AS at FROM neo_schedules WHERE next_at IS NOT NULL`,
    );
    return row?.at ?? undefined;
  }

  // ---- changes -------------------------------------------------------------------------------

  /**
   * Creates a schedule. `originKey` (a tool call's task id) makes a replayed call create one.
   */
  async create(
    agentId: string,
    input: ScheduleInput,
    createdBy: Schedule["createdBy"],
    timezone: string,
    options: { originKey?: string; system?: string } = {},
  ): Promise<Schedule> {
    if (options.originKey) {
      const existing = await this.db.get<Row>(
        `SELECT * FROM neo_schedules WHERE origin_key = ?`,
        options.originKey,
      );
      if (existing) return toSchedule(existing);
    }
    const active = await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM neo_schedules WHERE agent_id = ? AND next_at IS NOT NULL`,
      agentId,
    );
    if ((active?.n ?? 0) >= SCHEDULE_LIMIT)
      throw new ScheduleError(
        `At most ${SCHEDULE_LIMIT} schedules can be active; delete or turn off some first`,
      );
    const time = this.now();
    const fields = resolve(undefined, input, time, timezone);
    const row = await this.db.get<Row>(
      `INSERT INTO neo_schedules (id, agent_id, name, prompt, spec, anchor_at, timezone, window_start, window_end,
         when_busy, missed, quiet, enabled, system, created_by, origin_key, next_at, max_runs, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, system) DO NOTHING RETURNING *`,
      ulid(time),
      agentId,
      fields.name,
      fields.prompt,
      JSON.stringify(fields.spec),
      time,
      fields.timezone,
      fields.window?.start ?? null,
      fields.window?.end ?? null,
      fields.whenBusy,
      fields.missed,
      fields.quiet ? 1 : 0,
      fields.enabled ? 1 : 0,
      options.system ?? null,
      createdBy,
      options.originKey ?? null,
      null,
      fields.maxRuns,
      fields.endsAt,
      time,
      time,
    );
    if (!row) return (await this.system(agentId, options.system!))!;
    const created = toSchedule(row);
    await this.setNext(
      created.id,
      nextTime(created, time, time, timezone, true),
    );
    return (await this.get(agentId, created.id))!;
  }

  /** The agent's built-in schedule `key`, created with `defaults` the first time. */
  async ensureSystem(
    agentId: string,
    key: string,
    defaults: ScheduleInput,
    timezone: string,
  ): Promise<Schedule> {
    return (
      (await this.system(agentId, key)) ??
      this.create(agentId, defaults, "system", timezone, { system: key })
    );
  }

  async system(agentId: string, key: string): Promise<Schedule | undefined> {
    const row = await this.db.get<Row>(
      `SELECT * FROM neo_schedules WHERE agent_id = ? AND system = ?`,
      agentId,
      key,
    );
    return row ? toSchedule(row) : undefined;
  }

  /** Changes a schedule; its next time is computed again from now. */
  async update(
    agentId: string,
    id: string,
    change: ScheduleInput,
    timezone: string,
  ): Promise<Schedule | undefined> {
    const current = await this.get(agentId, id);
    if (!current) return undefined;
    const time = this.now();
    const fields = resolve(current, change, time, timezone);
    // A new timing restarts the count and the anchor; other changes keep them.
    const retimed =
      JSON.stringify(fields.spec) !== JSON.stringify(current.spec);
    await this.db.run(
      `UPDATE neo_schedules SET name = ?, prompt = ?, spec = ?, anchor_at = ?, timezone = ?, window_start = ?, window_end = ?,
         when_busy = ?, missed = ?, quiet = ?, enabled = ?, max_runs = ?, ends_at = ?, run_count = ?, updated_at = ?
       WHERE id = ?`,
      fields.name,
      fields.prompt,
      JSON.stringify(fields.spec),
      retimed ? time : await this.anchor(id),
      fields.timezone,
      fields.window?.start ?? null,
      fields.window?.end ?? null,
      fields.whenBusy,
      fields.missed,
      fields.quiet ? 1 : 0,
      fields.enabled ? 1 : 0,
      fields.maxRuns,
      fields.endsAt,
      retimed ? 0 : current.runCount,
      time,
      id,
    );
    const updated = (await this.get(agentId, id))!;
    await this.setNext(
      id,
      nextTime(updated, await this.anchor(id), time, timezone, true),
    );
    return this.get(agentId, id);
  }

  /** Deletes a schedule. Built-in ones can only be turned off. */
  async remove(agentId: string, id: string): Promise<boolean> {
    const current = await this.get(agentId, id);
    if (!current) return false;
    if (current.system)
      throw new ScheduleError(
        `${current.name} is built in; turn it off instead (enabled: false)`,
      );
    await this.db.transaction(async (tx) => {
      await tx.run(`DELETE FROM neo_schedules WHERE id = ?`, id);
      await tx.run(`DELETE FROM neo_schedule_runs WHERE schedule_id = ?`, id);
    });
    return true;
  }

  /** The person's timezone changed: every schedule that follows it gets its next time again. */
  async retime(timezone: string): Promise<void> {
    const time = this.now();
    const rows = await this.db.all<Row>(
      `SELECT * FROM neo_schedules WHERE next_at IS NOT NULL AND timezone IS NULL`,
    );
    for (const row of rows) {
      const schedule = toSchedule(row);
      if (schedule.spec.kind === "once") continue;
      await this.setNext(
        row.id,
        nextTime(schedule, row.anchor_at, time, timezone, true),
      );
    }
  }

  /** Makes an active schedule due now, or `ago` ms in the past (tests). */
  async dueNow(agentId: string, id: string, ago = 1): Promise<boolean> {
    const row = await this.db.get(
      `UPDATE neo_schedules SET next_at = ? WHERE id = ? AND agent_id = ? AND next_at IS NOT NULL RETURNING id`,
      this.now() - ago,
      id,
      agentId,
    );
    return row !== undefined;
  }

  // ---- firing --------------------------------------------------------------------------------

  /**
   * Fires everything due. Returns the runs it recorded and whether more are due (the caller
   * arms at once). One schedule failing never stops the others.
   */
  async fire(
    delivery: ScheduleDelivery,
  ): Promise<{ runs: (ScheduleRun & { agentId: string })[]; more: boolean }> {
    const due = await this.db.all<Row>(
      `SELECT * FROM neo_schedules WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?`,
      this.now(),
      BATCH + 1,
    );
    const runs: (ScheduleRun & { agentId: string })[] = [];
    const personTz = await delivery.timezone();
    for (const row of due.slice(0, BATCH)) {
      try {
        const run = await this.fireOne(row, delivery, personTz);
        if (run) runs.push({ ...run, agentId: row.agent_id });
      } catch {
        // A broken row (bad stored spec): turn it off rather than ring forever.
        await this.db.run(
          `UPDATE neo_schedules SET next_at = NULL, enabled = 0 WHERE id = ?`,
          row.id,
        );
      }
    }
    return { runs, more: due.length > BATCH };
  }

  private async fireOne(
    row: Row,
    delivery: ScheduleDelivery,
    personTz: string,
  ): Promise<ScheduleRun | undefined> {
    const schedule = toSchedule(row);
    const dueAt = row.next_at!;
    const time = this.now();
    const timezone = schedule.timezone ?? personTz;
    const recurring = schedule.spec.kind !== "once";
    const late = time - dueAt;

    let status: ScheduleRun["status"] = "sent";
    let reason: string | null = null;
    let message: MailboxMessage | undefined;
    if (recurring && schedule.missed === "skip" && late > GRACE_MS)
      reason = "missed";
    else if (
      recurring &&
      schedule.window &&
      !inWindow(schedule.window, time, timezone)
    )
      reason = "outside_window";
    else if (
      schedule.whenBusy === "skip" &&
      !(await delivery.idle(schedule.agentId))
    )
      reason = "busy";
    else if (
      recurring &&
      row.last_message_id &&
      (await delivery.waiting(row.last_message_id))
    )
      // The last one has not even started: a second copy would only pile up behind it.
      reason = "previous_pending";
    if (reason) status = "skipped";
    else {
      try {
        message = await delivery.send(schedule.agentId, {
          source: "schedule",
          text: schedule.prompt,
          meta: {
            scheduleId: schedule.id,
            name: schedule.name,
            dueAt,
            ...(late > 5 * 60_000 ? { late } : {}),
            ...(schedule.quiet ? { quiet: true } : {}),
          },
          // The due time is part of the id: firing the same occurrence twice sends one message.
          clientId: `schedule:${schedule.id}:${dueAt}`,
        });
      } catch (error) {
        status = "failed";
        reason =
          error instanceof Error ? error.message.slice(0, 300) : String(error);
      }
    }

    const sent = status === "sent" ? 1 : 0;
    const counted = { ...schedule, runCount: schedule.runCount + sent };
    let next = nextTime(
      counted,
      row.anchor_at,
      Math.max(time, dueAt),
      timezone,
      false,
    );
    // A failed send is tried again a few times (a reminder must not be lost to a passing error),
    // unless the schedule's own next time comes first.
    const retry = status === "failed" && row.failures < RETRY_MS.length;
    if (retry) {
      const at = time + RETRY_MS[row.failures]!;
      next = next === null ? at : Math.min(next, at);
      reason = `${reason} (trying again)`;
    }
    const failures = retry ? row.failures + 1 : 0;
    const runId = ulid(time);
    let recorded = false;
    await this.db.transaction(async (tx) => {
      // Only if nobody moved it meanwhile (an edit, another pass): then this occurrence is ours.
      const moved = await tx.get(
        `UPDATE neo_schedules SET next_at = ?, last_at = ?, run_count = run_count + ?,
           last_message_id = coalesce(?, last_message_id), failures = ?,
           enabled = CASE WHEN ? IS NULL AND ? THEN 0 ELSE enabled END
         WHERE id = ? AND next_at = ? RETURNING id`,
        next,
        time,
        sent,
        message?.id ?? null,
        failures,
        next,
        recurring ? 0 : 1,
        row.id,
        dueAt,
      );
      if (!moved) return;
      await tx.run(
        `INSERT INTO neo_schedule_runs (id, schedule_id, due_at, fired_at, status, reason, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (schedule_id, due_at) DO NOTHING`,
        runId,
        row.id,
        dueAt,
        time,
        status,
        reason,
        message?.id ?? null,
      );
      recorded = true;
    });
    if (!recorded) return undefined;
    return {
      id: runId,
      scheduleId: row.id,
      dueAt,
      firedAt: time,
      status,
      reason,
      messageId: message?.id ?? null,
    };
  }

  // ---- internals -----------------------------------------------------------------------------

  private async anchor(id: string): Promise<number> {
    return (await this.db.get<{ a: number }>(
      `SELECT anchor_at AS a FROM neo_schedules WHERE id = ?`,
      id,
    ))!.a;
  }

  private async setNext(id: string, at: number | null): Promise<void> {
    await this.db.run(
      `UPDATE neo_schedules SET next_at = ? WHERE id = ?`,
      at,
      id,
    );
  }
}

// ---- timing ----------------------------------------------------------------------------------

/**
 * The next time `schedule` fires after `from` (or at `from` for a new `once`), or null when it is
 * done: disabled, out of runs, past its end. `fresh` means it has not fired for this timing yet.
 */
export function nextTime(
  schedule: Schedule,
  anchorAt: number,
  from: number,
  timezone: string,
  fresh: boolean,
): number | null {
  if (!schedule.enabled) return null;
  if (schedule.maxRuns !== null && schedule.runCount >= schedule.maxRuns)
    return null;
  const tz = schedule.timezone ?? timezone;
  let at: number | null;
  const spec = schedule.spec;
  if (spec.kind === "once")
    at = fresh && schedule.runCount === 0 ? Math.max(spec.at, from) : null;
  else if (spec.kind === "every") {
    const step = spec.minutes * 60_000;
    const base = anchorAt || from;
    at = base + Math.max(1, Math.floor((from - base) / step) + 1) * step;
    if (schedule.window) at = intoWindow(at, schedule.window, tz);
  } else {
    at = cronNext(spec.expr, tz, from);
    // Cron already picks its hours; a window on top only filters.
    for (
      let i = 0;
      at !== null &&
      schedule.window &&
      !inWindow(schedule.window, at, tz) &&
      i < 2000;
      i++
    )
      at = cronNext(spec.expr, tz, at);
  }
  if (at !== null && schedule.endsAt !== null && at > schedule.endsAt)
    return null;
  return at;
}

function cronNext(
  expr: string,
  timezone: string,
  after: number,
): number | null {
  const next = new Cron(expr, { timezone, paused: true }).nextRun(
    new Date(after),
  );
  return next ? next.getTime() : null;
}

/** Moved forward to the window's next opening when it falls outside (minute steps, a day at most). */
function intoWindow(
  at: number,
  window: { start: string; end: string },
  timezone: string,
): number {
  if (inWindow(window, at, timezone)) return at;
  const start = toMinutes(window.start);
  const now = minutesOfDay(at, timezone);
  const wait = (start - now + 24 * 60) % (24 * 60);
  const moved = Math.floor(at / 60_000) * 60_000 + wait * 60_000;
  // A DST change in between can be off by an hour: settle on the next minute inside.
  for (let t = moved - 60 * 60_000, i = 0; i < 180; i++, t += 60_000)
    if (t >= at && inWindow(window, t, timezone)) return t;
  return moved;
}

export function inWindow(
  window: { start: string; end: string },
  at: number,
  timezone: string,
): boolean {
  const now = minutesOfDay(at, timezone);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// ---- input -----------------------------------------------------------------------------------

interface Fields {
  name: string;
  prompt: string;
  spec: ScheduleSpec;
  timezone: string | null;
  window: { start: string; end: string } | null;
  whenBusy: Schedule["whenBusy"];
  missed: Schedule["missed"];
  quiet: boolean;
  enabled: boolean;
  maxRuns: number | null;
  endsAt: number | null;
}

/** Checks an input against the current schedule (or none) and fills in the rest. */
function resolve(
  current: Schedule | undefined,
  input: ScheduleInput,
  now: number,
  personTz: string,
): Fields {
  const timing = [
    input.at,
    input.inMinutes,
    input.everyMinutes,
    input.cron,
  ].filter((v) => v !== undefined).length;
  if (timing > 1)
    throw new ScheduleError("Give one of at, inMinutes, everyMinutes or cron");
  const timezone =
    input.timezone === undefined ? (current?.timezone ?? null) : input.timezone;
  if (timezone !== null) checkTimezone(timezone);
  const tz = timezone ?? personTz;

  let spec: ScheduleSpec;
  if (input.at !== undefined || input.inMinutes !== undefined) {
    const at = parseTime(input, now, tz);
    if (at < now - 60_000) throw new ScheduleError("That time has passed");
    if (at > now + MAX_AHEAD)
      throw new ScheduleError("A one-time schedule is at most a year ahead");
    spec = { kind: "once", at: Math.max(at, now) };
  } else if (input.everyMinutes !== undefined) {
    if (
      !Number.isInteger(input.everyMinutes) ||
      input.everyMinutes < MIN_INTERVAL_MINUTES ||
      input.everyMinutes > 366 * 24 * 60
    )
      throw new ScheduleError(
        `everyMinutes is a whole number, at least ${MIN_INTERVAL_MINUTES}`,
      );
    spec = { kind: "every", minutes: input.everyMinutes };
  } else if (input.cron !== undefined) {
    spec = { kind: "cron", expr: checkCron(input.cron.trim(), tz, now) };
  } else if (current) spec = current.spec;
  else throw new ScheduleError("Say when: at, inMinutes, everyMinutes or cron");

  const prompt = (input.prompt ?? current?.prompt ?? "").trim();
  if (!prompt)
    throw new ScheduleError(
      "The prompt is empty: say what the agent should do then",
    );
  if (prompt.length > 4_000)
    throw new ScheduleError("The prompt is too long (4000 characters)");
  const name = (
    input.name ??
    current?.name ??
    prompt.split("\n")[0]!.slice(0, 60)
  ).trim();
  if (!name || name.length > 80)
    throw new ScheduleError("The name is 1-80 characters");

  const window =
    input.window === undefined ? (current?.window ?? null) : input.window;
  if (window && (!HHMM.test(window.start) || !HHMM.test(window.end)))
    throw new ScheduleError("window.start and window.end are HH:MM");
  const whenBusy = input.whenBusy ?? current?.whenBusy ?? "queue";
  if (whenBusy !== "queue" && whenBusy !== "skip")
    throw new ScheduleError("whenBusy is queue or skip");
  const missed = input.missed ?? current?.missed ?? "run";
  if (missed !== "run" && missed !== "skip")
    throw new ScheduleError("missed is run or skip");
  const maxRuns =
    input.maxRuns === undefined ? (current?.maxRuns ?? null) : input.maxRuns;
  if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1))
    throw new ScheduleError("maxRuns is at least 1");
  const endsAt =
    input.endsAt === undefined
      ? (current?.endsAt ?? null)
      : input.endsAt === null
        ? null
        : parseTime({ at: input.endsAt }, now, tz);
  return {
    name,
    prompt,
    spec,
    timezone,
    window,
    whenBusy,
    missed,
    quiet: input.quiet ?? current?.quiet ?? false,
    enabled: input.enabled ?? current?.enabled ?? true,
    maxRuns,
    endsAt,
  };
}

function checkTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new ScheduleError(`Unknown timezone ${timezone}`);
  }
}

function checkCron(expr: string, timezone: string, now: number): string {
  if (expr.split(/\s+/).length !== 5)
    throw new ScheduleError(
      "cron has five fields: minute hour day month weekday",
    );
  let first: number | null;
  try {
    first = cronNext(expr, timezone, now);
  } catch (error) {
    throw new ScheduleError(
      `Not a cron expression: ${error instanceof Error ? error.message : expr}`,
    );
  }
  if (first === null)
    throw new ScheduleError("That cron expression never fires");
  // The tightest gap in the next few runs.
  let previous = first;
  for (let i = 0; i < 5; i++) {
    const next = cronNext(expr, timezone, previous);
    if (next === null) break;
    if (next - previous < MIN_INTERVAL_MINUTES * 60_000)
      throw new ScheduleError(
        `A schedule fires at most every ${MIN_INTERVAL_MINUTES} minutes`,
      );
    previous = next;
  }
  return expr;
}

/** A time: minutes from now, an ISO time with an offset, or a local wall time in `timezone`. */
export function parseTime(
  input: { at?: string; inMinutes?: number },
  now: number,
  timezone: string,
): number {
  if (input.inMinutes !== undefined) {
    if (!(input.inMinutes > 0))
      throw new ScheduleError("inMinutes is more than 0");
    return now + Math.round(input.inMinutes * 60_000);
  }
  const text = (input.at ?? "").trim();
  if (!text) throw new ScheduleError("Give a time");
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(text)) {
    const at = Date.parse(text);
    if (Number.isNaN(at)) throw new ScheduleError(`Not a time: ${text}`);
    return at;
  }
  const match = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(
    text,
  );
  if (!match)
    throw new ScheduleError(
      "A time is like 2026-10-29T09:00 (local) or has an offset",
    );
  const [y, mo, d, h, mi] = match.slice(1, 6).map(Number) as number[];
  return zonedToUtc(y!, mo!, d!, h!, mi!, Number(match[6] ?? 0), timezone);
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

/** How a schedule reads to the person and the model. */
export function describeSpec(spec: ScheduleSpec, timezone: string): string {
  if (spec.kind === "once") return `once at ${new Date(spec.at).toISOString()}`;
  if (spec.kind === "every") return `every ${spec.minutes} minutes`;
  return `cron "${spec.expr}" (${timezone})`;
}

function toSchedule(row: Row): Schedule {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    spec: JSON.parse(row.spec) as ScheduleSpec,
    timezone: row.timezone,
    window:
      row.window_start && row.window_end
        ? { start: row.window_start, end: row.window_end }
        : null,
    whenBusy: row.when_busy,
    missed: row.missed,
    quiet: row.quiet === 1,
    enabled: row.enabled === 1,
    system: row.system,
    createdBy: row.created_by,
    nextAt: row.next_at,
    lastAt: row.last_at,
    runCount: row.run_count,
    maxRuns: row.max_runs,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
