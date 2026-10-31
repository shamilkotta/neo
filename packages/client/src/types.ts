// The wire types of Neo's HTTP API: what the kernel sends and every app (web, desktop, mobile)
// reads. The kernel imports these, so the API and its clients cannot drift apart.

export interface ModelRef {
  provider: string;
  modelId: string;
}

// ---- agent ----

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentRecord {
  id: string;
  name: string;
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  conversationId: number | null;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentChange {
  name?: string;
  model?: ModelRef | null;
  thinking?: ThinkingLevel | null;
}

// ---- mailbox and turns ----

export type MessageSource = "user" | "schedule" | "system";
export type MessageStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

/**
 * A file sent with a message, or by the agent to the person: a file in the instance's VFS, under
 * `/attachments/<id>/`. Its bytes are read with `GET /v1/files?path=`.
 */
export interface Attachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * What a message attaches when it is sent: a file already uploaded (`PUT /v1/files`). One under
 * `/.staging/` is moved into place, any other is copied. Name and type default to the file's.
 */
export interface AttachmentInput {
  path: string;
  name?: string;
  mimeType?: string;
}

export interface MailboxMessage {
  id: string;
  agentId: string;
  source: MessageSource;
  text: string;
  attachments: Attachment[];
  meta: Record<string, unknown>;
  clientId: string | null;
  status: MessageStatus;
  position: number;
  turnId: string | null;
  steered: boolean;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  settledAt: number | null;
}

export interface Turn {
  id: string;
  agentId: string;
  status: TurnStatus;
  answer: string | null;
  error: string | null;
  quiet: boolean;
  startedAt: number;
  endedAt: number | null;
}

/** One message as a turn's input shows it. */
export interface InputMessage {
  id: string;
  source: MessageSource;
  text: string;
  attachments?: Attachment[];
  at: number;
}

/** One thing the chat shows, built from the transcript. */
export type TranscriptItem =
  | {
      type: "input";
      entryId: number;
      turnId: string;
      steered: boolean;
      messages: InputMessage[];
    }
  | {
      type: "assistant";
      entryId: number;
      turnId: string | null;
      text: string;
      thinking: boolean;
      toolCalls: { id: string; name: string; args: unknown }[];
      stopReason: string | null;
      error: string | null;
    }
  | {
      type: "tool";
      entryId: number;
      turnId: string | null;
      toolCallId: string;
      name: string;
      output: string;
      isError: boolean;
      /** A file the agent sent the person (`send_file`). */
      file?: Attachment & { caption: string | null };
    }
  | { type: "compaction"; entryId: number; turnId: string | null }
  | { type: "reset"; entryId: number; turnId: string | null };

export interface TranscriptPage {
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  /** Pass as `before` for older items; null at the start. */
  before: number | null;
}

// ---- memory ----

export type MemoryKind = "essential" | "searchable";
export type MemoryOrigin = "manual" | "automatic";
export type MemoryOwnerKind = "agent" | "channel" | "connection";

export interface Memory {
  id: string;
  agentId: string;
  ownerKind: MemoryOwnerKind;
  kind: MemoryKind;
  origin: MemoryOrigin;
  userControlled: boolean;
  revision: number;
  text: string;
  createdAt: number;
  updatedAt: number;
}

// ---- schedules ----

/**
 * When a schedule fires. `once` is an instant; `every` repeats from its anchor; `cron` is a
 * five-field cron expression in the schedule's timezone.
 */
export type ScheduleSpec =
  | { kind: "once"; at: number }
  | { kind: "every"; minutes: number }
  | { kind: "cron"; expr: string };

/**
 * One thing that wakes the agent on a clock: a reminder, a routine, the heartbeat. They are all
 * the same row, fired by the same code; they differ only in their settings.
 */
export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  /** The message the agent gets each time. */
  prompt: string;
  spec: ScheduleSpec;
  /** IANA timezone for cron and the window; null: the person's timezone (follows it). */
  timezone: string | null;
  /** Fire only inside these local hours ("HH:MM"; start > end spans midnight). */
  window: { start: string; end: string } | null;
  /** When the agent is busy or paused: wait in the queue, or skip this time. */
  whenBusy: "queue" | "skip";
  /** When the host was down past the due time: run once late, or skip to the next time. */
  missed: "run" | "skip";
  /** The agent may answer QUIET_OK and the turn is hidden from the chat. */
  quiet: boolean;
  enabled: boolean;
  /** A built-in schedule ("heartbeat"): it can be changed or turned off, not deleted. */
  system: string | null;
  createdBy: "agent" | "system";
  /** null: nothing more to fire (done, ended, or disabled). */
  nextAt: number | null;
  lastAt: number | null;
  runCount: number;
  maxRuns: number | null;
  endsAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** How a schedule is written by a person, the agent, or an app. Times are local unless they have an offset. */
export interface ScheduleInput {
  name?: string;
  prompt?: string;
  at?: string;
  inMinutes?: number;
  everyMinutes?: number;
  cron?: string;
  timezone?: string | null;
  window?: { start: string; end: string } | null;
  whenBusy?: "queue" | "skip";
  missed?: "run" | "skip";
  quiet?: boolean;
  enabled?: boolean;
  maxRuns?: number | null;
  /** Stop after this time (same formats as `at`). */
  endsAt?: string | null;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  dueAt: number;
  firedAt: number;
  status: "sent" | "skipped" | "failed";
  /** Why it was skipped or failed: busy, outside_window, missed, previous_pending, no_model, or an error. */
  reason: string | null;
  messageId: string | null;
}

// ---- settings and models ----

export interface SettingsShape {
  /** The person's timezone: message times and schedules use it. */
  timezone: string;
}

export type ProviderKind =
  "anthropic" | "openai" | "openrouter" | "openai-compatible";

export interface CustomModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  /** Models of an OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter…). */
  models?: CustomModel[];
  /** Non-secret settings. */
  env?: Record<string, string>;
  /** Write-only: stored encrypted, never returned. */
  apiKey?: string;
}

export type ProviderInfo = Omit<ProviderConfig, "apiKey"> & { hasKey: boolean };

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
}

// ---- instance ----

export interface Status {
  version: string;
  host: string;
  state: "empty" | "active" | "sealed" | "moved";
  instanceId: string | undefined;
  epoch?: number;
  capabilities: { sockets: boolean; processes: boolean };
  test: boolean;
  agent?: { id: string; name: string; paused: boolean };
  model?: ModelRef | null;
  turn?: Turn | null;
  queued?: number;
  latestEvent?: number;
}

// ---- moving (POST /v1/move/*) ----

export interface ImportResult {
  instanceId: string;
  epoch: number;
  secrets: "kept" | "dropped";
}

// ---- events (GET /v1/events, server-sent) ----

/** A durable event: stored, numbered, replayed to a client that reconnects with `after`. */
export interface NeoEvent {
  seq: number;
  at: number;
  type: string;
  agentId: string | null;
  data: Record<string, unknown>;
}

/**
 * A live event: streamed to connected clients only, never stored. `type: "pi"` carries Pi's agent
 * events for the running turn (run_start/end, message_start/update/end with text deltas,
 * tool_execution_start/update/end, compaction_start/end).
 */
export interface LiveEvent {
  type: string;
  agentId: string | null;
  data: unknown;
}
