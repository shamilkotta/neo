// The wire types of Neo's HTTP API: what the kernel sends and every app (web, desktop, mobile)
// reads. The kernel imports these, so the API and its clients cannot drift apart.

export interface ModelRef {
  provider: string;
  modelId: string;
}

// ---- agent ----

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * The proactive heartbeat: every `everyMinutes`, within `activeHours` of the person's timezone, the
 * agent gets a heartbeat message and decides whether anything needs doing. A turn that has nothing
 * to say ends quiet and is hidden from the chat.
 */
export interface HeartbeatConfig {
  enabled: boolean;
  everyMinutes: number;
  /** "HH:MM" in the person's timezone; start > end spans midnight. Absent: all day. */
  activeHours?: { start: string; end: string };
  /** What the agent is asked; absent: the built-in checklist. */
  prompt?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  instructions: string;
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  conversationId: number | null;
  paused: boolean;
  heartbeat: HeartbeatConfig;
  heartbeatNextAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentChange {
  name?: string;
  instructions?: string;
  model?: ModelRef | null;
  thinking?: ThinkingLevel | null;
  heartbeat?: Partial<HeartbeatConfig>;
}

// ---- mailbox and turns ----

export type MessageSource = "user" | "wakeup" | "heartbeat" | "system";
export type MessageStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export interface MailboxMessage {
  id: string;
  agentId: string;
  source: MessageSource;
  text: string;
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

// ---- wake-ups ----

export interface Wakeup {
  id: string;
  agentId: string;
  at: number;
  note: string;
  status: "pending" | "fired" | "cancelled";
  createdBy: "agent" | "person";
  messageId: string | null;
  createdAt: number;
  firedAt: number | null;
}

// ---- settings and models ----

export interface SettingsShape {
  /** How many memories the agent can hold: 64, 128, 256 or 512 (OpenBot's choices). */
  memoryLimit: number;
  /** What a message sent while a turn runs does by default: wait in the queue, or join the turn. */
  busyMessageMode: "queue" | "steer";
  /** The person's timezone: message times, wake-ups and heartbeat hours use it. */
  timezone: string;
}

export type ProviderKind = "anthropic" | "openai" | "openrouter" | "openai-compatible";

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
  capabilities: { sockets: boolean; processes: boolean };
  test: boolean;
  agent?: { id: string; name: string; paused: boolean };
  model?: ModelRef | null;
  turn?: Turn | null;
  queued?: number;
  /** The newest durable event: subscribe with `after` set to this. */
  latestEvent?: number;
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
