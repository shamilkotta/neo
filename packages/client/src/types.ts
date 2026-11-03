import { Type, type Static, type TProperties, type TSchema } from "typebox";
import Value from "typebox/value";

export function parse<const S extends TSchema>(schema: S, value: unknown) {
  Value.Assert(schema, value);
  return value;
}

export function parseJson<const S extends TSchema>(schema: S, text: string) {
  return parse(schema, JSON.parse(text));
}

const Nullable = <const S extends TSchema>(schema: S) =>
  Type.Union([schema, Type.Null()]);

export const JsonObject = Type.Record(Type.String(), Type.Unknown());
export type JsonObject = Static<typeof JsonObject>;

export const JsonValue = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);
export type JsonValue = Static<typeof JsonValue>;

export const JsonData = Type.Record(Type.String(), JsonValue);
export type JsonData = Static<typeof JsonData>;

export const StringMap = Type.Record(Type.String(), Type.String());

export const ModelRef = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
});
export type ModelRef = Static<typeof ModelRef>;

export const ThinkingLevel = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export type AgentId = string & { readonly __brand: "AgentId" };

const AGENT_ID = "^[a-z0-9]+(-[a-z0-9]+)*$";

export const isAgentId = (value: string): value is AgentId =>
  value.length <= 64 && new RegExp(AGENT_ID).test(value);

export function agentId(value: string) {
  if (!isAgentId(value)) throw new Error(`Bad agent id ${value}`);
  return value;
}

export const AgentId = Type.Unsafe<AgentId>(
  Type.String({ pattern: AGENT_ID, maxLength: 64 }),
);

export const AgentProfile = Type.Object({
  id: AgentId,
  name: Type.String(),
  title: Nullable(Type.String()),
  description: Nullable(Type.String()),
  instructions: Nullable(Type.String()),
  primary: Type.Boolean(),
  createdBy: Nullable(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type AgentProfile = Static<typeof AgentProfile>;

export const AgentStatus = Type.Object({
  working: Type.Boolean(),
  queued: Type.Number(),
  paused: Type.Boolean(),
  at: Type.Number(),
});
export type AgentStatus = Static<typeof AgentStatus>;

export const AgentSummary = Type.Intersect([
  AgentProfile,
  Type.Object({ status: Nullable(AgentStatus) }),
]);
export type AgentSummary = Static<typeof AgentSummary>;

export const AgentRef = Type.Object({ id: AgentId, name: Type.String() });
export type AgentRef = Static<typeof AgentRef>;

/** A message between two agents of one instance (Durable Object to Durable Object). */
export interface AgentMessage {
  id: string;
  kind: "message" | "no-answer";
  instance: string;
  to: AgentId;
  from: AgentRef;
  text: string;
  replyTo: string | null;
  expectsReply: boolean;
  sentAt: number;
}

export const ProfileChange = Type.Object({
  name: Type.Optional(Type.String()),
  title: Type.Optional(Nullable(Type.String())),
  description: Type.Optional(Nullable(Type.String())),
  instructions: Type.Optional(Nullable(Type.String())),
});
export type ProfileChange = Static<typeof ProfileChange>;

export const NewAgent = Type.Intersect([
  ProfileChange,
  Type.Object({ name: Type.String() }),
]);
export type NewAgent = Static<typeof NewAgent>;

export const MessageSource = Type.Union([
  Type.Literal("user"),
  Type.Literal("schedule"),
  Type.Literal("system"),
  Type.Literal("agent"),
]);
export type MessageSource = Static<typeof MessageSource>;

export const MessageStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
  Type.Literal("cancelled"),
]);
export type MessageStatus = Static<typeof MessageStatus>;

export const TurnStatus = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
]);
export type TurnStatus = Static<typeof TurnStatus>;

export const Attachment = Type.Object({
  path: Type.String(),
  name: Type.String(),
  mimeType: Type.String(),
  size: Type.Number(),
});
export type Attachment = Static<typeof Attachment>;

export const Upload = Type.Object({
  id: Type.String(),
  name: Type.String(),
  size: Type.Number(),
});
export type Upload = Static<typeof Upload>;

export const AttachmentInput = Type.Object({
  id: Type.String(),
  mimeType: Type.Optional(Type.String()),
});
export type AttachmentInput = Static<typeof AttachmentInput>;

export const AgentMeta = Type.Union([
  Type.Object({
    kind: Type.Union([Type.Literal("message"), Type.Literal("no-answer")]),
    messageId: Type.String(),
    from: AgentRef,
    replyTo: Nullable(Type.String()),
    expectsReply: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal("group"),
    messageId: Type.String(),
    from: AgentRef,
    count: Type.Number(),
  }),
]);
export type AgentMeta = Static<typeof AgentMeta>;

export const ScheduleMeta = Type.Object({
  scheduleId: Type.String(),
  name: Type.String(),
  dueAt: Type.Number(),
  late: Type.Optional(Type.Number()),
  quiet: Type.Optional(Type.Boolean()),
});
export type ScheduleMeta = Static<typeof ScheduleMeta>;

export const MessageOrigin = Type.Union([
  Type.Object({ source: Type.Literal("user") }),
  Type.Object({ source: Type.Literal("system") }),
  Type.Object({ source: Type.Literal("schedule"), meta: ScheduleMeta }),
  Type.Object({ source: Type.Literal("agent"), meta: AgentMeta }),
]);
export type MessageOrigin = Static<typeof MessageOrigin>;

export const MailboxMessage = Type.Intersect([
  MessageOrigin,
  Type.Object({
    id: Type.String(),
    text: Type.String(),
    attachments: Type.Array(Attachment),
    clientId: Nullable(Type.String()),
    status: MessageStatus,
    position: Type.Number(),
    turnId: Nullable(Type.String()),
    steered: Type.Boolean(),
    error: Nullable(Type.String()),
    createdAt: Type.Number(),
    startedAt: Nullable(Type.Number()),
    settledAt: Nullable(Type.Number()),
  }),
]);
export type MailboxMessage = Static<typeof MailboxMessage>;

export const Turn = Type.Object({
  id: Type.String(),
  status: TurnStatus,
  answer: Nullable(Type.String()),
  error: Nullable(Type.String()),
  quiet: Type.Boolean(),
  startedAt: Type.Number(),
  endedAt: Nullable(Type.Number()),
});
export type Turn = Static<typeof Turn>;

export const InputMessage = Type.Object({
  id: Type.String(),
  source: MessageSource,
  text: Type.String(),
  attachments: Type.Array(Attachment),
  at: Type.Number(),
});
export type InputMessage = Static<typeof InputMessage>;

export const ToolCall = Type.Object({
  id: Type.String(),
  name: Type.String(),
  args: Type.Unknown(),
});
export type ToolCall = Static<typeof ToolCall>;

export const TranscriptItem = Type.Union([
  Type.Object({
    type: Type.Literal("input"),
    entryId: Type.Number(),
    turnId: Type.String(),
    steered: Type.Boolean(),
    messages: Type.Array(InputMessage),
  }),
  Type.Object({
    type: Type.Literal("assistant"),
    entryId: Type.Number(),
    turnId: Nullable(Type.String()),
    text: Type.String(),
    thinking: Type.Boolean(),
    toolCalls: Type.Array(ToolCall),
    stopReason: Nullable(Type.String()),
    error: Nullable(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("tool"),
    entryId: Type.Number(),
    turnId: Nullable(Type.String()),
    toolCallId: Type.String(),
    name: Type.String(),
    output: Type.String(),
    isError: Type.Boolean(),
    file: Type.Optional(
      Type.Intersect([
        Attachment,
        Type.Object({ caption: Nullable(Type.String()) }),
      ]),
    ),
  }),
  Type.Object({
    type: Type.Literal("compaction"),
    entryId: Type.Number(),
    turnId: Nullable(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("reset"),
    entryId: Type.Number(),
    turnId: Nullable(Type.String()),
  }),
]);
export type TranscriptItem = Static<typeof TranscriptItem>;

export const TranscriptPage = Type.Object({
  items: Type.Array(TranscriptItem),
  turns: Type.Record(Type.String(), Turn),
  before: Nullable(Type.Number()),
});
export type TranscriptPage = Static<typeof TranscriptPage>;

export const MemoryKind = Type.Union([
  Type.Literal("essential"),
  Type.Literal("searchable"),
]);
export type MemoryKind = Static<typeof MemoryKind>;

export const MemoryOrigin = Type.Union([
  Type.Literal("manual"),
  Type.Literal("automatic"),
]);
export type MemoryOrigin = Static<typeof MemoryOrigin>;

export const MemoryOwnerKind = Type.Union([
  Type.Literal("agent"),
  Type.Literal("channel"),
  Type.Literal("connection"),
]);
export type MemoryOwnerKind = Static<typeof MemoryOwnerKind>;

export const Memory = Type.Object({
  id: Type.String(),
  ownerKind: MemoryOwnerKind,
  kind: MemoryKind,
  origin: MemoryOrigin,
  userControlled: Type.Boolean(),
  revision: Type.Number(),
  text: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type Memory = Static<typeof Memory>;

export const ScheduleSpec = Type.Union([
  Type.Object({ kind: Type.Literal("once"), at: Type.Number() }),
  Type.Object({ kind: Type.Literal("every"), minutes: Type.Number() }),
  Type.Object({ kind: Type.Literal("cron"), expr: Type.String() }),
]);
export type ScheduleSpec = Static<typeof ScheduleSpec>;

export const TimeWindow = Type.Object({
  start: Type.String(),
  end: Type.String(),
});
export type TimeWindow = Static<typeof TimeWindow>;

export const WhenBusy = Type.Union([
  Type.Literal("queue"),
  Type.Literal("skip"),
]);
export const Missed = Type.Union([Type.Literal("run"), Type.Literal("skip")]);

export const Schedule = Type.Object({
  id: Type.String(),
  name: Type.String(),
  prompt: Type.String(),
  spec: ScheduleSpec,
  timezone: Nullable(Type.String()),
  window: Nullable(TimeWindow),
  whenBusy: WhenBusy,
  missed: Missed,
  quiet: Type.Boolean(),
  enabled: Type.Boolean(),
  system: Nullable(Type.String()),
  createdBy: Type.Union([Type.Literal("agent"), Type.Literal("system")]),
  nextAt: Nullable(Type.Number()),
  lastAt: Nullable(Type.Number()),
  runCount: Type.Number(),
  maxRuns: Nullable(Type.Number()),
  endsAt: Nullable(Type.Number()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type Schedule = Static<typeof Schedule>;

export const ScheduleInput = Type.Object({
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  inMinutes: Type.Optional(Type.Number()),
  everyMinutes: Type.Optional(Type.Number()),
  cron: Type.Optional(Type.String()),
  timezone: Type.Optional(Nullable(Type.String())),
  window: Type.Optional(Nullable(TimeWindow)),
  whenBusy: Type.Optional(WhenBusy),
  missed: Type.Optional(Missed),
  quiet: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
  maxRuns: Type.Optional(Nullable(Type.Number())),
  endsAt: Type.Optional(Nullable(Type.String())),
});
export type ScheduleInput = Static<typeof ScheduleInput>;

export const ScheduleRun = Type.Object({
  id: Type.String(),
  scheduleId: Type.String(),
  dueAt: Type.Number(),
  firedAt: Type.Number(),
  status: Type.Union([
    Type.Literal("sent"),
    Type.Literal("skipped"),
    Type.Literal("failed"),
  ]),
  reason: Nullable(Type.String()),
  messageId: Nullable(Type.String()),
});
export type ScheduleRun = Static<typeof ScheduleRun>;

export const SettingsShape = Type.Object({
  timezone: Type.String(),
  model: Nullable(ModelRef),
  thinking: Nullable(ThinkingLevel),
});
export type SettingsShape = Static<typeof SettingsShape>;

export const SettingsChange = Type.Partial(SettingsShape);
export type SettingsChange = Static<typeof SettingsChange>;

export const ProviderKind = Type.Union([
  Type.Literal("anthropic"),
  Type.Literal("openai"),
  Type.Literal("openrouter"),
  Type.Literal("openai-compatible"),
]);
export type ProviderKind = Static<typeof ProviderKind>;

export const CustomModel = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(
    Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  ),
});
export type CustomModel = Static<typeof CustomModel>;

export const BuiltinKind = Type.Union([
  Type.Literal("anthropic"),
  Type.Literal("openai"),
  Type.Literal("openrouter"),
]);
export type BuiltinKind = Static<typeof BuiltinKind>;

const builtin = <const K extends BuiltinKind>(kind: K) =>
  Type.Object({
    id: Type.Literal(kind),
    kind: Type.Literal(kind),
    env: Type.Optional(StringMap),
  });

export const ProviderSetup = Type.Union([
  builtin("anthropic"),
  builtin("openai"),
  builtin("openrouter"),
  Type.Object({
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
    kind: Type.Literal("openai-compatible"),
    baseUrl: Type.String({ minLength: 1 }),
    models: Type.Array(CustomModel, { minItems: 1 }),
    env: Type.Optional(StringMap),
  }),
]);
export type ProviderSetup = Static<typeof ProviderSetup>;

export const ProviderConfig = Type.Intersect([
  ProviderSetup,
  Type.Object({ apiKey: Type.Optional(Type.String()) }),
]);
export type ProviderConfig = Static<typeof ProviderConfig>;

export const ProviderInfo = Type.Intersect([
  ProviderSetup,
  Type.Object({ hasKey: Type.Boolean() }),
]);
export type ProviderInfo = Static<typeof ProviderInfo>;

export const AvailableModel = Type.Object({
  provider: Type.String(),
  id: Type.String(),
  name: Type.String(),
});
export type AvailableModel = Static<typeof AvailableModel>;

export const InstanceState = Type.Union([
  Type.Literal("empty"),
  Type.Literal("active"),
  Type.Literal("sealed"),
  Type.Literal("moved"),
]);
export type InstanceState = Static<typeof InstanceState>;

export const Status = Type.Object({
  version: Type.String(),
  host: Type.String(),
  state: InstanceState,
  instanceId: Type.Optional(Type.String()),
  epoch: Type.Optional(Type.Number()),
  capabilities: Type.Object({
    sockets: Type.Boolean(),
    processes: Type.Boolean(),
  }),
  test: Type.Boolean(),
  model: Type.Optional(Nullable(ModelRef)),
  agents: Type.Optional(Type.Array(AgentSummary)),
  latestEvent: Type.Optional(Type.Number()),
});
export type Status = Static<typeof Status>;

export const AgentView = Type.Intersect([
  AgentProfile,
  Type.Object({ paused: Type.Boolean() }),
]);
export type AgentView = Static<typeof AgentView>;

const agentStateFields = {
  turn: Nullable(Turn),
  queued: Type.Number(),
  latestEvent: Type.Number(),
};

export const AgentState = Type.Union([
  Type.Object({
    state: Type.Literal("active"),
    agent: AgentView,
    ...agentStateFields,
  }),
  Type.Object({
    state: Type.Union([
      Type.Literal("empty"),
      Type.Literal("sealed"),
      Type.Literal("moved"),
    ]),
    agent: Type.Object({ id: Type.String() }),
    ...agentStateFields,
  }),
]);
export type AgentState = Static<typeof AgentState>;

export const ImportResult = Type.Object({
  instanceId: Type.String(),
  epoch: Type.Number(),
  secrets: Type.Union([Type.Literal("kept"), Type.Literal("dropped")]),
});
export type ImportResult = Static<typeof ImportResult>;

const event = <const T extends string, const D extends TProperties>(
  type: T,
  data: D,
) => Type.Object({ type: Type.Literal(type), data: Type.Object(data) });

export const EventBody = Type.Union([
  event("agent.created", { agent: AgentProfile }),
  event("agent.changed", { agent: AgentProfile }),
  event("agent.deleted", { agentId: AgentId }),
  event("agent.status", { agentId: AgentId, status: AgentStatus }),
  event("agent.paused", {}),
  event("agent.resumed", {}),
  event("settings.changed", {}),
  event("providers.changed", {}),
  event("instance.sealed", {}),
  event("instance.unsealed", {}),
  event("instance.imported", {
    from: Type.String(),
    epoch: Type.Number(),
  }),
  event("agent.imported", {}),
  event("schedule.changed", {}),
  event("schedule.fired", {
    scheduleId: Type.String(),
    status: ScheduleRun.properties.status,
    reason: Nullable(Type.String()),
    messageId: Nullable(Type.String()),
  }),
  event("memory.changed", { turnId: Type.String(), applied: Type.Number() }),
  event("message.queued", { message: MailboxMessage }),
  event("message.edited", { message: MailboxMessage }),
  event("message.steered", {
    messageId: Type.String(),
    turnId: Type.String(),
  }),
  event("message.cancelled", { messageId: Type.String() }),
  event("message.requeued", { messageId: Type.String() }),
  event("message.settled", { messageId: Type.String(), status: MessageStatus }),
  event("queue.reordered", {}),
  event("turn.started", {
    turnId: Type.String(),
    messageIds: Type.Array(Type.String()),
  }),
  event("turn.stopping", {}),
  event("turn.ended", { turn: Turn }),
  event("error", { where: Type.String(), message: Type.String() }),
]);
export type EventBody = Static<typeof EventBody>;
export type EventType = EventBody["type"];

export const NeoEvent = Type.Intersect([
  Type.Object({ seq: Type.Number(), at: Type.Number() }),
  EventBody,
]);
export type NeoEvent = Static<typeof NeoEvent>;

export const LiveEvent = Type.Object({
  type: Type.String(),
  data: Type.Unknown(),
});
export type LiveEvent = Static<typeof LiveEvent>;
