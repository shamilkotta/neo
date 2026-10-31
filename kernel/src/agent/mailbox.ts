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
  // Every message to an agent, from arrival to settle (OpenBot's mailbox deliveries).
  await tx.exec(`CREATE TABLE neo_mailbox (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'schedule', 'system')),
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
    `CREATE INDEX neo_mailbox_queue ON neo_mailbox (agent_id, status, position)`,
  );
  await tx.exec(`CREATE INDEX neo_mailbox_by_turn ON neo_mailbox (turn_id)`);
  // One turn: the messages it started with (and any steered in), answered by one Pi run.
  await tx.exec(`CREATE TABLE neo_turns (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
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
    `CREATE INDEX neo_turns_by_status ON neo_turns (agent_id, status, started_at)`,
  );
};

/** What the turn's input entry carries, so the transcript shows each message as it was sent. */
export interface InputEntryData {
  turnId: string;
  steered?: boolean;
  messages: InputMessage[];
  [key: string]: unknown;
}

export const INPUT_ENTRY = "neo.input";

export interface SendInput {
  text: string;
  /** Files already in place (`placeAttachments`). */
  attachments?: Attachment[];
  source?: MessageSource;
  meta?: Record<string, unknown>;
  /** The client's id for the message; a retry with the same id is the same message. */
  clientId?: string;
  /** Join the running turn at its next step instead of waiting for it. */
  steer?: boolean;
}

export interface MailboxHooks {
  /** The agent's Pi conversation, configured for its next request. */
  conversation(agentId: string): Promise<Conversation>;
  /** Called before anything that can start work, so the host's recovery alarm is armed first. */
  beforeWork(): Promise<void>;
  /** A turn ended. Memory commits here (or is dropped) before the next turn starts. */
  turnSettled(turn: Turn, messages: MailboxMessage[]): Promise<void>;
  paused(agentId: string): Promise<boolean>;
  /** How messages are dated in the prompt. */
  timezone(): Promise<string>;
  /** Which attached images the agent's model is sent inline, and a note for those it is not. */
  checkImages(
    agentId: string,
    attachments: Attachment[],
  ): Promise<{ inline: Set<string>; notes: Map<string, string> }>;
  /** An inline image's bytes, read when the turn is submitted. */
  readImage(path: string, mimeType: string): Promise<ImageContent | undefined>;
}

/** A turn's input as stored: images by path, so their bytes are never kept in a row. */
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
  agent_id: string;
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
  agent_id: string;
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

/**
 * The agent's message queue and its turns. Neo owns the queue (as OpenBot owns its mailbox), and
 * Pi owns a run: Pi only ever sees one input per turn, plus steers, so its own inbox stays empty.
 *
 * - **send**: a `queued` row, deduplicated by `clientId`, then `drain`.
 * - **drain** (idle and not paused): every queued row, in order, starts one turn together
 *   (`starting` → Pi submit with the turn id as request id → `running`).
 * - **steer**: a queued message joins the running turn at its next step (Pi `whenBusy: "steer"`).
 * - **stop**: Pi abort; the turn and its messages end `interrupted`, and the queue moves on.
 * - **settle**: Pi's submission settled; the turn and its rows end, `turnSettled` runs, then `drain`.
 * - **recover** (start): running turns are submitted again under their own id (Pi finds the one it
 *   admitted, or admits it now) and followed to the end; Pi resumes the run where it was.
 *
 * Every change runs in the agent's lane, one after another, so a send, a stop and a settle never
 * interleave.
 */
export class Mailbox {
  private readonly lanes = new Map<string, Promise<unknown>>();
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

  // ---- reads ---------------------------------------------------------------------------------

  async message(id: string): Promise<MailboxMessage | undefined> {
    const row = await this.db.get<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE id = ?`,
      id,
    );
    return row ? toMessage(row) : undefined;
  }

  /** What waits for the agent, in the order it will run. */
  async queue(agentId: string): Promise<MailboxMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE agent_id = ? AND status = 'queued' ORDER BY position, created_at`,
      agentId,
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

  async currentTurn(agentId: string): Promise<Turn | undefined> {
    const row = await this.db.get<TurnRow>(
      `SELECT * FROM neo_turns WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
      agentId,
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

  /** Quiet turns (a quiet schedule with nothing to say) are hidden from the transcript. */
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

  // ---- changes -------------------------------------------------------------------------------

  async byClientId(clientId: string): Promise<MailboxMessage | undefined> {
    const row = await this.db.get<MessageRow>(
      `SELECT * FROM neo_mailbox WHERE client_id = ?`,
      clientId,
    );
    return row ? toMessage(row) : undefined;
  }

  async send(agentId: string, input: SendInput): Promise<MailboxMessage> {
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
    const message = await this.lane(agentId, async () => {
      if (input.clientId) {
        const existing = await this.db.get<MessageRow>(
          `SELECT * FROM neo_mailbox WHERE client_id = ?`,
          input.clientId,
        );
        if (existing) return { message: toMessage(existing), fresh: false };
      }
      const time = this.now();
      const row = await this.db.get<MessageRow>(
        `INSERT INTO neo_mailbox (id, agent_id, source, text, attachments, meta, client_id, status, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING *`,
        ulid(time),
        agentId,
        input.source ?? "user",
        text,
        JSON.stringify(attachments),
        JSON.stringify(input.meta ?? {}),
        input.clientId ?? null,
        await this.nextPosition(agentId),
        time,
      );
      return { message: toMessage(row!), fresh: true };
    });
    if (!message.fresh) return message.message;
    await this.events.emit(
      "message.queued",
      { message: message.message },
      agentId,
    );
    if (input.steer && (await this.currentTurn(agentId))) {
      await this.steer(agentId, message.message.id).catch(() =>
        this.drain(agentId),
      );
    } else {
      await this.drain(agentId);
    }
    return (await this.message(message.message.id))!;
  }

  /** Starts a turn with everything queued, when the agent is idle and not paused. */
  drain(agentId: string): Promise<void> {
    return this.lane(agentId, async () => {
      if (this.closed || (await this.hooks.paused(agentId))) return;
      if (await this.currentTurn(agentId)) return;
      const queued = await this.queue(agentId);
      if (queued.length === 0) return;
      const time = this.now();
      const turnId = ulid(time);
      const { content, images } = await this.prompt(agentId, queued);
      const data: InputEntryData = {
        turnId,
        messages: queued.map(inputMessage),
      };
      const input: TurnInput = {
        content,
        ...(images.length ? { images } : {}),
        entry: { kind: INPUT_ENTRY, data },
      };
      // The turn and its rows first, in one commit: a crash after this is a turn recovery submits.
      await this.db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO neo_turns (id, agent_id, status, input, started_at) VALUES (?, ?, 'running', ?, ?)`,
          turnId,
          agentId,
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
        agentId,
      );
      await this.submitTurn(agentId, turnId, input);
    });
  }

  /** Sends a queued message into the running turn now. Refused when no turn runs. */
  steer(agentId: string, messageId: string): Promise<void> {
    return this.lane(agentId, async () => {
      const message = await this.message(messageId);
      if (
        !message ||
        message.agentId !== agentId ||
        message.status !== "queued"
      )
        throw new MailboxError(
          "Only a queued message can join the running turn",
        );
      const turn = await this.currentTurn(agentId);
      if (!turn) throw new MailboxError("No turn is running");
      const data: InputEntryData = {
        turnId: turn.id,
        steered: true,
        messages: [inputMessage(message)],
      };
      const prompt = await this.prompt(agentId, [message], true);
      await this.db.run(
        `UPDATE neo_mailbox SET status = 'starting', turn_id = ?, steered = 1, started_at = ? WHERE id = ?`,
        turn.id,
        this.now(),
        message.id,
      );
      await this.hooks.beforeWork();
      const conversation = await this.hooks.conversation(agentId);
      // The message's own id is the request id: Pi admits a steer once, even if this is retried.
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
        agentId,
      );
      this.trackSteer(agentId, message.id, submission.id);
    });
  }

  /** Stops the running turn. Its messages end interrupted; the queue moves on unless paused. */
  async stop(agentId: string): Promise<boolean> {
    const stopped = await this.lane(agentId, async () => {
      const turn = await this.currentTurn(agentId);
      if (!turn) return false;
      await this.db.run(
        `UPDATE neo_turns SET stop_requested = 1 WHERE id = ?`,
        turn.id,
      );
      await (await this.hooks.conversation(agentId)).abort(context);
      return true;
    });
    if (stopped) await this.events.emit("turn.stopping", {}, agentId);
    return stopped;
  }

  async cancel(agentId: string, messageId: string): Promise<void> {
    await this.lane(agentId, async () => {
      const changed = await this.db.get(
        `UPDATE neo_mailbox SET status = 'cancelled', settled_at = ? WHERE id = ? AND agent_id = ? AND status = 'queued' RETURNING id`,
        this.now(),
        messageId,
        agentId,
      );
      if (!changed)
        throw new MailboxError("Only a queued message can be cancelled");
    });
    await this.events.emit("message.cancelled", { messageId }, agentId);
  }

  async edit(
    agentId: string,
    messageId: string,
    text: string,
  ): Promise<MailboxMessage> {
    const trimmed = text.trim();
    if (!trimmed) throw new MailboxError("The message is empty");
    if (trimmed.length > MAX_TEXT)
      throw new MailboxError(
        `The message is too long (${MAX_TEXT} characters)`,
      );
    const row = await this.lane(agentId, () =>
      this.db.get<MessageRow>(
        `UPDATE neo_mailbox SET text = ? WHERE id = ? AND agent_id = ? AND status = 'queued' RETURNING *`,
        trimmed,
        messageId,
        agentId,
      ),
    );
    if (!row) throw new MailboxError("Only a queued message can be edited");
    const message = toMessage(row);
    await this.events.emit("message.edited", { message }, agentId);
    return message;
  }

  /** Puts the queue in this order; ids left out keep their order after the named ones. */
  async reorder(agentId: string, order: string[]): Promise<MailboxMessage[]> {
    await this.lane(agentId, async () => {
      const queued = await this.queue(agentId);
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
    await this.events.emit("queue.reordered", {}, agentId);
    return this.queue(agentId);
  }

  /**
   * Picks up what the last process left: turns that were running are submitted again (Pi dedupes
   * by the turn id) and followed; steers likewise. Then the queue drains.
   */
  async recover(agentId: string): Promise<void> {
    await this.lane(agentId, async () => {
      const running = await this.db.all<TurnRow>(
        `SELECT * FROM neo_turns WHERE agent_id = ? AND status = 'running' ORDER BY started_at`,
        agentId,
      );
      for (const turn of running)
        await this.submitTurn(agentId, turn.id, JSON.parse(turn.input));
      const steers = await this.db.all<MessageRow>(
        `SELECT * FROM neo_mailbox WHERE agent_id = ? AND steered = 1 AND status IN ('starting', 'running')`,
        agentId,
      );
      for (const row of steers) {
        if (row.pi_submission !== null)
          this.trackSteer(agentId, row.id, row.pi_submission as SubmissionId);
        else
          // Cut off before Pi admitted it: it waits in the queue again.
          await this.db.run(
            `UPDATE neo_mailbox SET status = 'queued', turn_id = NULL, steered = 0, started_at = NULL WHERE id = ?`,
            row.id,
          );
      }
    });
    await this.drain(agentId);
  }

  // ---- internals -----------------------------------------------------------------------------

  private async submitTurn(
    agentId: string,
    turnId: string,
    input: TurnInput,
  ): Promise<void> {
    await this.hooks.beforeWork();
    const conversation = await this.hooks.conversation(agentId);
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
    this.trackTurn(agentId, turnId, submission.id);
  }

  private trackTurn(
    agentId: string,
    turnId: string,
    submissionId: SubmissionId,
  ): void {
    this.follow(`turn:${turnId}`, submissionId, (record) =>
      this.lane(agentId, () => this.settleTurn(agentId, turnId, record)),
    );
  }

  private trackSteer(
    agentId: string,
    messageId: string,
    submissionId: SubmissionId,
  ): void {
    this.follow(`steer:${messageId}`, submissionId, (record) =>
      this.lane(agentId, () => this.settleSteer(agentId, messageId, record)),
    );
  }

  /** Waits for a Pi submission in the background, once per key. */
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
        // The harness closed (shutdown, seal): the next start's recovery follows it again.
      } finally {
        this.tracking.delete(key);
      }
    })();
  }

  private async settleTurn(
    agentId: string,
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
        ? await this.entryText(agentId, record.answer)
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
      // Steered messages settle with their own submission; the rest with the turn.
      await tx.run(
        `UPDATE neo_mailbox SET status = ?, error = ?, settled_at = ? WHERE turn_id = ? AND steered = 0 AND status IN ('starting', 'running')`,
        status,
        error,
        time,
        turnId,
      );
    });
    const turn = (await this.turn(turnId))!;
    await this.events.emit("turn.ended", { turn }, agentId);
    try {
      await this.hooks.turnSettled(turn, await this.turnMessages(turnId));
    } catch (e) {
      await this.events.emit(
        "error",
        { where: "turn.settled", message: errorText(e) },
        agentId,
      );
    }
    // The next turn starts after this lane step: drain queues behind it.
    void this.drain(agentId);
  }

  private async settleSteer(
    agentId: string,
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
      // Withdrawn before it reached the transcript (a stop): it waits in the queue again.
      await this.db.run(
        `UPDATE neo_mailbox SET status = 'queued', turn_id = NULL, steered = 0, pi_submission = NULL, started_at = NULL WHERE id = ?`,
        messageId,
      );
      await this.events.emit("message.requeued", { messageId }, agentId);
      void this.drain(agentId);
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
    await this.events.emit("message.settled", { messageId, status }, agentId);
  }

  /** The text of an answer entry. */
  private async entryText(
    agentId: string,
    entryId: unknown,
  ): Promise<string | null> {
    const conversation = await this.hooks.conversation(agentId);
    const page = await conversation.entries(
      { order: "descending" },
      50,
      undefined,
      context,
    );
    const entry = page.items.find((e) => e.id === entryId);
    return entry ? textOf(entry) : null;
  }

  /**
   * The model's view of the messages a turn starts with (OpenBot's combined delivery). Every
   * attachment is listed by path, so the agent can come back to it; images its model can see are
   * also sent inline (by path here, read at submit).
   */
  private async prompt(
    agentId: string,
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
          agentId,
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

  /** Pi's input: the text, then the inline images, read now. An image gone since is left out. */
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

  private async nextPosition(agentId: string): Promise<number> {
    const row = await this.db.get<{ p: number | null }>(
      `SELECT max(position) AS p FROM neo_mailbox WHERE agent_id = ? AND status = 'queued'`,
      agentId,
    );
    return (row?.p ?? 0) + 1;
  }

  /** Runs `work` after everything already in the agent's lane. */
  private lane<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const before = this.lanes.get(agentId) ?? Promise.resolve();
    const run = before.catch(() => {}).then(work);
    const tail = run.catch(() => {});
    this.lanes.set(agentId, tail);
    void tail.then(() => {
      if (this.lanes.get(agentId) === tail) this.lanes.delete(agentId);
    });
    return run;
  }
}

export class MailboxError extends Error {}

const SOURCE_LABEL: Record<MessageSource, string> = {
  user: "Message from the person",
  schedule: "Your schedule",
  system: "System notice",
};

function header(message: MailboxMessage, timezone: string): string {
  const at = formatTime(message.createdAt, timezone);
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
    agentId: row.agent_id,
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
    agentId: row.agent_id,
    status: row.status,
    answer: row.answer,
    error: row.error,
    quiet: row.quiet === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
