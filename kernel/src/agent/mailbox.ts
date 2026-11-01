import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  EntryRecord,
  Harness,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ulid } from "../ids";
import { type Attachment, attachmentsBlock } from "./attachments";
import { type AgentMeta, agentHeader } from "./messaging";
import { QUIET_REPLY } from "./schedules";
import type { Events } from "../services/events";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type {
  MessageSource,
  MessageStatus,
  TurnStatus,
  MailboxMessage,
  Turn,
  InputMessage,
} from "@neo/client";
export type {
  MessageSource,
  MessageStatus,
  TurnStatus,
  MailboxMessage,
  Turn,
} from "@neo/client";

export const MAILBOX_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_mailbox (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('user', 'schedule', 'system', 'agent')),
    text TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    client_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
    position REAL NOT NULL,
    turn_id TEXT,
    steered INTEGER NOT NULL DEFAULT 0,
    pi_submission INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    settled_at INTEGER
  ) STRICT`);
  await tx.exec(
    `CREATE INDEX neo_mailbox_queue ON neo_mailbox (status, position)`,
  );
  await tx.exec(`CREATE INDEX neo_mailbox_by_turn ON neo_mailbox (turn_id)`);
  await tx.exec(`CREATE TABLE neo_turns (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
    input TEXT NOT NULL,
    pi_submission INTEGER,
    answer TEXT,
    error TEXT,
    quiet INTEGER NOT NULL DEFAULT 0,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  ) STRICT`);
  await tx.exec(
    `CREATE INDEX neo_turns_by_status ON neo_turns (status, started_at)`,
  );
};

export interface InputEntryData {
  turnId: string;
  steered?: boolean;
  messages: InputMessage[];
  [key: string]: unknown;
}

export const INPUT_ENTRY = "neo.input";

export interface SendInput {
  text: string;
  attachments?: Attachment[];
  source?: MessageSource;
  meta?: Record<string, unknown>;
  clientId?: string;
  steer?: boolean;
}

export interface MailboxHooks {
  conversation(): Promise<Conversation>;
  beforeWork(): Promise<void>;
  turnSettled(turn: Turn, messages: MailboxMessage[]): Promise<void>;
  paused(): Promise<boolean>;
  timezone(): Promise<string>;
  checkImages(
    attachments: Attachment[],
  ): Promise<{ inline: Set<string>; notes: Map<string, string> }>;
  readImage(path: string, mimeType: string): Promise<ImageContent | undefined>;
}

interface TurnInput {
  content: string;
  images?: InlineImage[];
  entry: { kind: string; data: InputEntryData };
}

interface InlineImage {
  path: string;
  mimeType: string;
}

interface MessageRow {
  id: string;
  source: MessageSource;
  text: string;
  attachments: string;
  meta: string;
  client_id: string | null;
  status: MessageStatus;
  position: number;
  turn_id: string | null;
  steered: number;
  pi_submission: number | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  settled_at: number | null;
}

interface TurnRow {
  id: string;
  status: TurnStatus;
  input: string;
  pi_submission: number | null;
  answer: string | null;
  error: string | null;
  quiet: number;
  stop_requested: number;
  started_at: number;
  ended_at: number | null;
}

const context = BACKGROUND_CONTEXT;
const MAX_TEXT = 100_000;

export class Mailbox {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly tracking = new Set<string>();
  private closed = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly harness: Harness,
    private readonly events: Events,
    private readonly hooks: MailboxHooks,
    private readonly now: () => number,
  ) {}

  close(): void {
    this.closed = true;
  }


  async message(id: string): Promise<MailboxMessage | undefined> {
    const row = await this.db.get<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE id = ?`,
      id,
    );
    return row ? toMessage(row) : undefined;
  }

  async queue(): Promise<MailboxMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE status = 'queued' ORDER BY position, created_at`,
    );
    return rows.map(toMessage);
  }

  async turn(id: string): Promise<Turn | undefined> {
    const row = await this.db.get<TurnRow>(
      `SELECT * FROM neo_turns WHERE id = ?`,
      id,
    );
    return row ? toTurn(row) : undefined;
  }

  async currentTurn(): Promise<Turn | undefined> {
    const row = await this.db.get<TurnRow>(
      `SELECT * FROM neo_turns WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    );
    return row ? toTurn(row) : undefined;
  }

  async turnMessages(turnId: string): Promise<MailboxMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE turn_id = ? ORDER BY steered, position, created_at`,
      turnId,
    );
    return rows.map(toMessage);
  }

  async quietTurns(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM neo_turns WHERE quiet = 1 AND id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    return new Set(rows.map((r) => r.id));
  }

  async turnStates(ids: string[]): Promise<Map<string, Turn>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.all<TurnRow>(
      `SELECT * FROM neo_turns WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    return new Map(rows.map((r) => [r.id, toTurn(r)]));
  }


  async byClientId(clientId: string): Promise<MailboxMessage | undefined> {
    const row = await this.db.get<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE client_id = ?`,
      clientId,
    );
    return row ? toMessage(row) : undefined;
  }

  async send(input: SendInput): Promise<MailboxMessage> {
    const text = input.text.trim();
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0)
      throw new MailboxError("The message is empty");
    if (text.length > MAX_TEXT)
      throw new MailboxError(
        `The message is too long (${MAX_TEXT} characters)`,
      );
    if (
      input.clientId !== undefined &&
      !/^[\w.:-]{1,100}$/.test(input.clientId)
    )
      throw new MailboxError(
        "clientId is 1-100 letters, digits, '.', ':', '_' or '-'",
      );
    const message = await this.lane(async () => {
      if (input.clientId) {
        const existing = await this.db.get<MessageRow>(
          `SELECT * FROM neo_mailbox WHERE client_id = ?`,
          input.clientId,
        );
        if (existing) return { message: toMessage(existing), fresh: false };
      }
      const time = this.now();
      const row = await this.db.get<MessageRow>(
        `INSERT INTO neo_mailbox (id, source, text, attachments, meta, client_id, status, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING *`,
        ulid(time),
        input.source ?? "user",
        text,
        JSON.stringify(attachments),
        JSON.stringify(input.meta ?? {}),
        input.clientId ?? null,
        await this.nextPosition(),
        time,
      );
      return { message: toMessage(row!), fresh: true };
    });
    if (!message.fresh) return message.message;
    await this.events.emit(
      "message.queued",
      { message: message.message },
    );
    if (input.steer && (await this.currentTurn())) {
      await this.steer(message.message.id).catch(() =>
        this.drain(),
      );
    } else {
      await this.drain();
    }
    return (await this.message(message.message.id))!;
  }

  drain(): Promise<void> {
    return this.lane(async () => {
      if (this.closed || (await this.hooks.paused())) return;
      if (await this.currentTurn()) return;
      const queued = await this.queue();
      if (queued.length === 0) return;
      const time = this.now();
      const turnId = ulid(time);
      const { content, images } = await this.prompt(queued);
      const data: InputEntryData = {
        turnId,
        messages: queued.map(inputMessage),
      };
      const input: TurnInput = {
        content,
        ...(images.length ? { images } : {}),
        entry: { kind: INPUT_ENTRY, data },
      };
      await this.db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO neo_turns (id, status, input, started_at) VALUES (?, 'running', ?, ?)`,
          turnId,
          JSON.stringify(input),
          time,
        );
        for (const m of queued)
          await tx.run(
            `UPDATE neo_mailbox SET status = 'starting', turn_id = ?, started_at = ? WHERE id = ? AND status = 'queued'`,
            turnId,
            time,
            m.id,
          );
      });
      await this.events.emit(
        "turn.started",
        { turnId, messageIds: queued.map((m) => m.id) },
      );
      await this.submitTurn(turnId, input);
    });
  }

  steer(messageId: string): Promise<void> {
    return this.lane(async () => {
      const message = await this.message(messageId);
      if (
        !message ||
        message.status !== "queued"
      )
        throw new MailboxError(
          "Only a queued message can join the running turn",
        );
      const turn = await this.currentTurn();
      if (!turn) throw new MailboxError("No turn is running");
      const data: InputEntryData = {
        turnId: turn.id,
        steered: true,
        messages: [inputMessage(message)],
      };
      const prompt = await this.prompt([message], true);
      await this.db.run(
        `UPDATE neo_mailbox SET status = 'starting', turn_id = ?, steered = 1, started_at = ? WHERE id = ?`,
        turn.id,
        this.now(),
        message.id,
      );
      await this.hooks.beforeWork();
      const conversation = await this.hooks.conversation();
      const submission = await conversation.submit(
        {
          type: "input",
          content: await this.content(prompt.content, prompt.images),
          requestId: `steer:${message.id}`,
          whenBusy: "steer",
          entry: { kind: INPUT_ENTRY, data: data as never },
        },
        context,
      );
      await this.db.run(
        `UPDATE neo_mailbox SET status = 'running', pi_submission = ? WHERE id = ?`,
        submission.id,
        message.id,
      );
      await this.events.emit(
        "message.steered",
        { messageId, turnId: turn.id },
      );
      this.trackSteer(message.id, submission.id);
    });
  }

  async stop(): Promise<boolean> {
    const stopped = await this.lane(async () => {
      const turn = await this.currentTurn();
      if (!turn) return false;
      await this.db.run(
        `UPDATE neo_turns SET stop_requested = 1 WHERE id = ?`,
        turn.id,
      );
      await (await this.hooks.conversation()).abort(context);
      return true;
    });
    if (stopped) await this.events.emit("turn.stopping", {});
    return stopped;
  }

  async cancel(messageId: string): Promise<void> {
    await this.lane(async () => {
      const changed = await this.db.get(
        `UPDATE neo_mailbox SET status = 'cancelled', settled_at = ? WHERE id = ? AND status = 'queued' RETURNING id`,
        this.now(),
        messageId,
      );
      if (!changed)
        throw new MailboxError("Only a queued message can be cancelled");
    });
    await this.events.emit("message.cancelled", { messageId });
  }

  async edit(
    messageId: string,
    text: string,
  ): Promise<MailboxMessage> {
    const trimmed = text.trim();
    if (!trimmed) throw new MailboxError("The message is empty");
    if (trimmed.length > MAX_TEXT)
      throw new MailboxError(
        `The message is too long (${MAX_TEXT} characters)`,
      );
    const row = await this.lane(() =>
      this.db.get<MessageRow>(
        `UPDATE neo_mailbox SET text = ? WHERE id = ? AND status = 'queued' RETURNING *`,
        trimmed,
        messageId,
      ),
    );
    if (!row) throw new MailboxError("Only a queued message can be edited");
    const message = toMessage(row);
    await this.events.emit("message.edited", { message });
    return message;
  }

  async reorder(order: string[]): Promise<MailboxMessage[]> {
    await this.lane(async () => {
      const queued = await this.queue();
      const known = new Set(queued.map((m) => m.id));
      const named = [...new Set(order)].filter((id) => known.has(id));
      const rest = queued.map((m) => m.id).filter((id) => !named.includes(id));
      await this.db.transaction(async (tx) => {
        let position = 1;
        for (const id of [...named, ...rest])
          await tx.run(
            `UPDATE neo_mailbox SET position = ? WHERE id = ?`,
            position++,
            id,
          );
      });
    });
    await this.events.emit("queue.reordered", {});
    return this.queue();
  }

  async recover(): Promise<void> {
    await this.lane(async () => {
      const running = await this.db.all<TurnRow>(
        `SELECT * FROM neo_turns WHERE status = 'running' ORDER BY started_at`,
      );
      for (const turn of running)
        await this.submitTurn(turn.id, JSON.parse(turn.input));
      const steers = await this.db.all<MessageRow>(
        `SELECT * FROM neo_mailbox WHERE steered = 1 AND status IN ('starting', 'running')`,
      );
      for (const row of steers) {
        if (row.pi_submission !== null)
          this.trackSteer(row.id, row.pi_submission as SubmissionId);
        else
          await this.db.run(
            `UPDATE neo_mailbox SET status = 'queued', turn_id = NULL, steered = 0, started_at = NULL WHERE id = ?`,
            row.id,
          );
      }
    });
    await this.drain();
  }


  private async submitTurn(
    turnId: string,
    input: TurnInput,
  ): Promise<void> {
    await this.hooks.beforeWork();
    const conversation = await this.hooks.conversation();
    const submission = await conversation.submit(
      {
        type: "input",
        content: await this.content(input.content, input.images ?? []),
        requestId: `turn:${turnId}`,
        entry: { kind: input.entry.kind, data: input.entry.data as never },
      },
      context,
    );
    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE neo_turns SET pi_submission = ? WHERE id = ?`,
        submission.id,
        turnId,
      );
      await tx.run(
        `UPDATE neo_mailbox SET status = 'running', pi_submission = ? WHERE turn_id = ? AND steered = 0 AND status = 'starting'`,
        submission.id,
        turnId,
      );
    });
    this.trackTurn(turnId, submission.id);
  }

  private trackTurn(
    turnId: string,
    submissionId: SubmissionId,
  ): void {
    this.follow(`turn:${turnId}`, submissionId, (record) =>
      this.lane(() => this.settleTurn(turnId, record)),
    );
  }

  private trackSteer(
    messageId: string,
    submissionId: SubmissionId,
  ): void {
    this.follow(`steer:${messageId}`, submissionId, (record) =>
      this.lane(() => this.settleSteer(messageId, record)),
    );
  }

  private follow(
    key: string,
    submissionId: SubmissionId,
    settled: (record: SubmissionRecord) => Promise<unknown>,
  ): void {
    if (this.tracking.has(key)) return;
    this.tracking.add(key);
    void (async () => {
      try {
        const submission = await this.harness.submission(submissionId, context);
        if (!submission) throw new Error("Pi has no such submission");
        const record = await submission.wait(context);
        if (!this.closed) await settled(record);
      } catch {
      } finally {
        this.tracking.delete(key);
      }
    })();
  }

  private async settleTurn(
    turnId: string,
    record: SubmissionRecord,
  ): Promise<void> {
    const row = await this.db.get<TurnRow>(
      `SELECT * FROM neo_turns WHERE id = ?`,
      turnId,
    );
    if (!row || row.status !== "running") return;
    const { status, error } = outcome(record, row.stop_requested === 1);
    const answer =
      record.status === "done"
        ? await this.entryText(record.answer)
        : null;
    const messages = await this.turnMessages(turnId);
    const quiet =
      status === "completed" &&
      messages.every((m) => m.source === "schedule" && m.meta.quiet === true) &&
      (answer ?? "").trim() === QUIET_REPLY;
    const time = this.now();
    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE neo_turns SET status = ?, answer = ?, error = ?, quiet = ?, ended_at = ? WHERE id = ?`,
        status,
        answer,
        error,
        quiet ? 1 : 0,
        time,
        turnId,
      );
      await tx.run(
        `UPDATE neo_mailbox SET status = ?, error = ?, settled_at = ? WHERE turn_id = ? AND steered = 0 AND status IN ('starting', 'running')`,
        status,
        error,
        time,
        turnId,
      );
    });
    const turn = (await this.turn(turnId))!;
    await this.events.emit("turn.ended", { turn });
    try {
      await this.hooks.turnSettled(turn, await this.turnMessages(turnId));
    } catch (e) {
      await this.events.emit(
        "error",
        { where: "turn.settled", message: errorText(e) },
      );
    }
    void this.drain();
  }

  private async settleSteer(
    messageId: string,
    record: SubmissionRecord,
  ): Promise<void> {
    const message = await this.message(messageId);
    if (
      !message ||
      (message.status !== "running" && message.status !== "starting")
    )
      return;
    if (record.status === "unanswered" && record.entry === undefined) {
      await this.db.run(
        `UPDATE neo_mailbox SET status = 'queued', turn_id = NULL, steered = 0, pi_submission = NULL, started_at = NULL WHERE id = ?`,
        messageId,
      );
      await this.events.emit("message.requeued", { messageId });
      void this.drain();
      return;
    }
    const turn = message.turnId ? await this.turn(message.turnId) : undefined;
    const { status, error } = outcome(record, false);
    await this.db.run(
      `UPDATE neo_mailbox SET status = ?, error = ?, settled_at = ? WHERE id = ?`,
      turn?.status === "interrupted" ? "interrupted" : status,
      error,
      this.now(),
      messageId,
    );
    await this.events.emit("message.settled", { messageId, status });
  }

  private async entryText(
    entryId: unknown,
  ): Promise<string | null> {
    const conversation = await this.hooks.conversation();
    const page = await conversation.entries(
      { order: "descending" },
      50,
      undefined,
      context,
    );
    const entry = page.items.find((e) => e.id === entryId);
    return entry ? textOf(entry) : null;
  }

  private async prompt(
    messages: MailboxMessage[],
    steered = false,
  ): Promise<{ content: string; images: InlineImage[] }> {
    const timezone = await this.hooks.timezone();
    const images: InlineImage[] = [];
    const parts: string[] = [];
    for (const m of messages) {
      let part = header(m, timezone);
      if (m.text) part += `\n${m.text}`;
      if (m.attachments.length) {
        const { inline, notes } = await this.hooks.checkImages(
          m.attachments,
        );
        part += `\n${attachmentsBlock(m.attachments, inline, notes)}`;
        for (const a of m.attachments)
          if (inline.has(a.path))
            images.push({ path: a.path, mimeType: a.mimeType });
      }
      parts.push(part);
    }
    const content = steered
      ? `[This message arrived while you were working. Take it into account.]\n${parts[0]}`
      : parts.length === 1
        ? parts[0]!
        : `This turn starts with ${parts.length} messages. Read all of them before you answer.\n\n${parts.join("\n\n---\n\n")}`;
    return { content, images };
  }

  private async content(
    text: string,
    images: InlineImage[],
  ): Promise<string | (TextContent | ImageContent)[]> {
    const read: ImageContent[] = [];
    for (const image of images) {
      const content = await this.hooks
        .readImage(image.path, image.mimeType)
        .catch(() => undefined);
      if (content) read.push(content);
    }
    return read.length ? [{ type: "text", text }, ...read] : text;
  }

  private async nextPosition(): Promise<number> {
    const row = await this.db.get<{ p: number | null }>(
      `SELECT max(position) AS p FROM neo_mailbox WHERE status = 'queued'`,
    );
    return (row?.p ?? 0) + 1;
  }

  private lane<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => {}).then(work);
    this.tail = run.catch(() => {});
    return run;
  }
}

export class MailboxError extends Error {}

const SOURCE_LABEL: Record<MessageSource, string> = {
  user: "Message from the person",
  schedule: "Your schedule",
  system: "System notice",
  agent: "Message from a teammate",
};

function header(message: MailboxMessage, timezone: string): string {
  const at = formatTime(message.createdAt, timezone);
  if (message.source === "agent")
    return agentHeader(message.meta as AgentMeta, at);
  if (message.source !== "schedule")
    return `[${SOURCE_LABEL[message.source]} · ${at}]`;
  const { name, scheduleId, dueAt, late, quiet } = message.meta as {
    name?: string;
    scheduleId?: string;
    dueAt?: number;
    late?: number;
    quiet?: boolean;
  };
  const lines = [
    `[Your schedule "${name ?? "?"}" (${scheduleId ?? "?"}) · ${at}]`,
  ];
  if (late && dueAt)
    lines.push(
      `[It was due ${formatTime(dueAt, timezone)}; the host was not running then.]`,
    );
  if (quiet)
    lines.push(
      `[If there is nothing worth telling the person, answer exactly ${QUIET_REPLY} and nothing else; it is not shown.]`,
    );
  return lines.join("\n");
}

export function formatTime(at: number, timezone: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at)} (${timezone})`;
}

function outcome(
  record: SubmissionRecord,
  stopRequested: boolean,
): { status: Exclude<TurnStatus, "running">; error: string | null } {
  if (record.status === "done") return { status: "completed", error: null };
  if (stopRequested || record.reason === "aborted")
    return { status: "interrupted", error: null };
  const detail =
    record.detail === undefined
      ? ""
      : `: ${JSON.stringify(record.detail).slice(0, 500)}`;
  return { status: "failed", error: `${record.reason ?? "failed"}${detail}` };
}

export function textOf(entry: EntryRecord): string | null {
  const message = entry.model?.[0] as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((c: { type?: string }) => c.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inputMessage(m: MailboxMessage): InputMessage {
  return {
    id: m.id,
    source: m.source,
    text: m.text,
    ...(m.attachments.length ? { attachments: m.attachments } : {}),
    at: m.createdAt,
  };
}

function toMessage(row: MessageRow): MailboxMessage {
  return {
    id: row.id,
    source: row.source,
    text: row.text,
    attachments: JSON.parse(row.attachments) as Attachment[],
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    clientId: row.client_id,
    status: row.status,
    position: row.position,
    turnId: row.turn_id,
    steered: row.steered === 1,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
  };
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    status: row.status,
    answer: row.answer,
    error: row.error,
    quiet: row.quiet === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
