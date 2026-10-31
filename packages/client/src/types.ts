
export interface ModelRef {
  provider: string;
  modelId: string;
}


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

export interface Attachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface Upload {
  id: string;
  name: string;
  size: number;
}

export interface AttachmentInput {
  id: string;
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

export interface InputMessage {
  id: string;
  source: MessageSource;
  text: string;
  attachments?: Attachment[];
  at: number;
}

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
      file?: Attachment & { caption: string | null };
    }
  | { type: "compaction"; entryId: number; turnId: string | null }
  | { type: "reset"; entryId: number; turnId: string | null };

export interface TranscriptPage {
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  before: number | null;
}


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


export type ScheduleSpec =
  | { kind: "once"; at: number }
  | { kind: "every"; minutes: number }
  | { kind: "cron"; expr: string };

export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  spec: ScheduleSpec;
  timezone: string | null;
  window: { start: string; end: string } | null;
  whenBusy: "queue" | "skip";
  missed: "run" | "skip";
  quiet: boolean;
  enabled: boolean;
  system: string | null;
  createdBy: "agent" | "system";
  nextAt: number | null;
  lastAt: number | null;
  runCount: number;
  maxRuns: number | null;
  endsAt: number | null;
  createdAt: number;
  updatedAt: number;
}

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
  endsAt?: string | null;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  dueAt: number;
  firedAt: number;
  status: "sent" | "skipped" | "failed";
  reason: string | null;
  messageId: string | null;
}


export interface SettingsShape {
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
  models?: CustomModel[];
  env?: Record<string, string>;
  apiKey?: string;
}

export type ProviderInfo = Omit<ProviderConfig, "apiKey"> & { hasKey: boolean };

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
}


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


export interface ImportResult {
  instanceId: string;
  epoch: number;
  secrets: "kept" | "dropped";
}


export interface NeoEvent {
  seq: number;
  at: number;
  type: string;
  agentId: string | null;
  data: Record<string, unknown>;
}

export interface LiveEvent {
  type: string;
  agentId: string | null;
  data: unknown;
}
