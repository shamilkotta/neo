import { isConversationId } from "./pi-ids";
import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import {
  type AgentEventStream,
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  type Wake,
  watchEvents,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import {
  type AgentId,
  type AgentMessage,
  type AgentProfile,
  type EventType,
  isAgentId,
  type QuestionAnswer,
} from "@neo/client";
import { AgentSelf } from "./agent/agents";
import {
  ATTACHMENTS_ROOT,
  type AttachmentInput,
  inlineCheck,
  placeUploads,
  stageUpload,
  sweepStaging,
} from "./agent/attachments";
import { askTools } from "./agent/tools/ask";
import { fileTools } from "./agent/tools/files";
import { findQuestion } from "./agent/transcript";
import {
  Mailbox,
  MailboxError,
  type MailboxMessage,
  type Turn,
} from "./agent/mailbox";
import { Messaging } from "./agent/messaging";
import { teamTools } from "./agent/tools/team";
import { promptSections } from "./agent/prompt";
import { historyTools } from "./agent/tools/history";
import { memoryTools } from "./agent/tools/memory";
import type { ToolServices } from "./agent/tools/shared";
import { scheduleTools } from "./agent/tools/schedules";
import { HEARTBEAT, Schedules } from "./agent/schedules";
import { handleAgentApi } from "./api";
import type { Address, AgentPorts } from "./host";
import type { AgentConfig, AgentInit } from "./links";
import { toBase64 } from "./crypto";
import { SetupError, StateError, storedState } from "./errors";
import { decodeNdjson, encodeNdjson, readPart, writePart } from "./move/bundle";
import { wipeDatabase } from "./move/snapshot";
import { createAgentSchema, getMeta, hasTable, setMeta } from "./schema";
import { Events } from "./services/events";
import { History } from "./services/history";
import { Memories } from "./services/memory";
import { ModelCatalog } from "./services/providers";
import type { SqliteDatabase } from "./sql";
import { VfsShell } from "./vfs/bash";
import { VfsExecutionEnv } from "./vfs/env";
import { mount, remoteVfs, SHARED_ROOT } from "./vfs/mount";
import { joinPath, readOnly, Vfs, WHOLE_READ_MAX } from "./vfs/vfs";

export const NEO_VERSION = "0.2.0";
export const PI_PREFIX = "pi_";
export const RECOVERY_MS = 60_000;
export const IMPORT_MARKER = "host_import";

export type { InstanceState } from "./errors";
import type { InstanceState } from "./errors";

export interface Live {
  harness: Harness;
  vfs: Vfs;
  self: AgentSelf;
  memories: Memories;
  history: History;
  mailbox: Mailbox;
  messaging: Messaging;
  schedules: Schedules;
  watches: AgentEventStream[];
}

type Held = {
  state: Exclude<InstanceState, "empty">;
  agentId: AgentId;
  instance: string;
};
type Home = { state: "empty" } | Held;

const EMPTY: Home = { state: "empty" };

const STATUS_EVENTS = new Set<EventType>([
  "message.queued",
  "message.cancelled",
  "message.steered",
  "message.requeued",
  "turn.started",
  "turn.ended",
  "agent.paused",
  "agent.resumed",
]);

export class NeoAgent {
  readonly events: Events;
  readonly now: () => number;
  readonly catalog = new ModelCatalog();
  private live: Live | undefined;
  private home: Home = EMPTY;
  private readonly context: Context = BACKGROUND_CONTEXT;
  private armed: number | undefined | null = null;
  private arming: Promise<void> = Promise.resolve();
  private waking: Promise<void> | undefined;
  private configured: string | undefined;
  private conversation_: Conversation | undefined;
  private config_: AgentConfig | undefined;
  private stale = true;
  private reporting: Promise<void> | undefined;
  private reportAgain = false;

  private constructor(readonly host: AgentPorts) {
    this.now = host.now ?? Date.now;
    this.events = new Events(host.db, this.now);
    if (host.test) this.catalog.addHostProvider(host.test.provider);
    this.events.subscribe((event) => {
      if (STATUS_EVENTS.has(event.type)) this.report();
      if (event.type === "message.cancelled" && this.live)
        void this.live.messaging
          .cancelled(event.data.messageId)
          .catch(() => {});
    });
  }

  static async open(host: AgentPorts) {
    const agent = new NeoAgent(host);
    if (await hasTable(host.db, IMPORT_MARKER)) {
      await wipeDatabase(host.db);
      await host.blobs.clear();
    }
    if (await hasTable(host.db, "neo_meta")) {
      const state = storedState(await getMeta(host.db, "state"));
      const agentId = await getMeta(host.db, "agent_id");
      const instance = await getMeta(host.db, "instance");
      if (state !== "empty" && agentId && isAgentId(agentId) && instance)
        agent.home = { state, agentId, instance };
    }
    if (agent.home.state === "active") await agent.start();
    return agent;
  }

  get state() {
    return this.home.state;
  }

  get agentId() {
    return this.held().agentId;
  }

  private held() {
    if (this.home.state === "empty")
      throw new StateError("empty", "No such agent");
    return this.home;
  }

  services() {
    if (!this.live)
      throw new StateError(this.home.state, `The agent is ${this.home.state}`);
    return this.live;
  }

  fetch(request: Request) {
    return handleAgentApi(this, request);
  }

  private link() {
    return this.host.coordinator(this.held().instance);
  }

  async claim(address: Address) {
    if (this.home.state !== "empty") return true;
    const init = await this.host
      .coordinator(address.instance)
      .init(address.agentId);
    if (!init) return false;
    await this.provision(init);
    return true;
  }

  async provision(init: AgentInit) {
    const { db } = this.host;
    if (this.home.state !== "empty") {
      if (this.home.agentId !== init.profile.id)
        throw new StateError(this.home.state, "This home holds another agent");
      await this.setInstance(this.home, init.instance);
      if (this.live) await this.live.self.setProfile(init.profile);
      return;
    }
    await createAgentSchema(db);
    await setMeta(db, "agent_id", init.profile.id);
    await setMeta(db, "instance_id", init.instanceId);
    await setMeta(db, "instance", init.instance);
    await setMeta(db, "created_at", String(this.now()));
    await new AgentSelf(db).init(init.profile);
    await this.setState(
      { state: "active", agentId: init.profile.id, instance: init.instance },
      "active",
    );
    await this.start();
  }

  private async setInstance(home: Held, instance: string) {
    if (home.instance === instance) return;
    this.home = { ...home, instance };
    await setMeta(this.host.db, "instance", instance);
  }

  async profileChanged(profile: AgentProfile) {
    if (this.home.state === "empty" || this.home.agentId !== profile.id) return;
    await new AgentSelf(this.host.db).setProfile(profile);
    if (this.live) await this.live.self.setProfile(profile);
    await this.events.emit({ type: "agent.changed", data: { agent: profile } });
  }

  async config() {
    if (this.config_ && !this.stale) return this.config_;
    let fresh: AgentConfig;
    try {
      fresh = await this.link().config();
    } catch (error) {
      if (this.config_) return this.config_;
      throw error;
    }
    const before = this.config_;
    this.config_ = fresh;
    this.stale = false;
    await this.catalog.rebuild(fresh.providers);
    if (before && before.timezone !== fresh.timezone && this.live) {
      await this.live.schedules.retime(fresh.timezone);
      await this.arm();
    }
    return fresh;
  }

  async configChanged(revision: number) {
    if (this.config_ && revision <= this.config_.revision) return;
    this.stale = true;
    if (this.live) await this.config().catch(() => {});
  }

  async timezone() {
    return (await this.config()).timezone;
  }

  async status() {
    const live = this.live;
    if (!live) return undefined;
    return {
      working: !!(await live.mailbox.currentTurn()),
      queued: (await live.mailbox.queue()).length,
      paused: (await live.self.get()).paused,
      at: this.now(),
    };
  }

  private report() {
    if (this.reporting) {
      this.reportAgain = true;
      return;
    }
    this.reporting = (async () => {
      do {
        this.reportAgain = false;
        const status = await this.status().catch(() => undefined);
        const home = this.home;
        if (status && home.state !== "empty")
          await this.host
            .coordinator(home.instance)
            .report(home.agentId, status)
            .catch(() => {});
      } while (this.reportAgain);
    })().finally(() => {
      this.reporting = undefined;
    });
  }

  async deliver(message: AgentMessage) {
    if (
      this.home.state === "empty" &&
      !(await this.claim({ instance: message.instance, agentId: message.to }))
    )
      throw new Error(`No agent ${message.to}`);
    if (this.home.state !== "active")
      throw new StateError(
        this.home.state,
        `${message.to} is not taking messages right now (${this.home.state})`,
      );
    await this.services().messaging.deliver(message);
  }

  async interrupt(
    address: Address,
    from: AgentId,
  ): Promise<{ stopped: boolean; cancelled: number }> {
    if (this.home.state === "empty") await this.claim(address);
    const live = this.services();
    await live.messaging.closeFrom(from);
    const fromThem = (m: MailboxMessage) =>
      m.source === "agent" && m.meta.from.id === from;
    let cancelled = 0;
    for (const m of await live.mailbox.queue())
      if (fromThem(m)) {
        await live.mailbox.cancel(m.id).catch(() => {});
        cancelled++;
      }
    const turn = await live.mailbox.currentTurn();
    const stopped =
      !!turn &&
      (await live.mailbox.turnMessages(turn.id)).some(fromThem) &&
      (await live.mailbox.stop());
    return { stopped, cancelled };
  }

  async isNew() {
    if (this.home.state === "empty") return true;
    if (this.home.state !== "active") return false;
    const used = await this.host.db.get(
      `SELECT 1 FROM neo_mailbox UNION ALL SELECT 1 FROM neo_memories UNION ALL SELECT 1 FROM vfs_nodes WHERE kind = 'file' LIMIT 1`,
    );
    return used === undefined;
  }

  async seal() {
    if (this.home.state === "sealed") return;
    if (this.home.state !== "active")
      throw new StateError(this.home.state, `The agent is ${this.home.state}`);
    await this.stop();
    await this.setState(this.home, "sealed");
    await this.events.emit({ type: "instance.sealed", data: {} });
  }

  async unseal() {
    if (this.home.state === "active") return;
    if (this.home.state !== "sealed")
      throw new StateError(this.home.state, "The agent is not sealed");
    await this.setState(this.home, "active");
    await this.start();
    await this.events.emit({ type: "instance.unsealed", data: {} });
  }

  async markMoved() {
    if (this.home.state === "moved") return;
    if (this.home.state !== "sealed")
      throw new StateError(this.home.state, "Seal and export the agent first");
    await this.setState(this.home, "moved");
  }

  exportPart() {
    if (this.home.state !== "sealed" && this.home.state !== "moved")
      throw new StateError(
        this.home.state,
        "Seal the agent before exporting it",
      );
    return encodeNdjson(writePart(this.host.db, this.host.blobs));
  }

  async importPart(init: AgentInit, part: ReadableStream<Uint8Array>) {
    const { db, blobs } = this.host;
    await this.reset();
    await db.exec(`CREATE TABLE ${IMPORT_MARKER} (started_at INTEGER) STRICT`);
    try {
      await readPart(decodeNdjson(part)[Symbol.asyncIterator](), db, blobs);
      if ((await getMeta(db, "agent_id")) !== init.profile.id)
        throw new Error("The bundle's agent and its part disagree");
      await setMeta(db, "instance_id", init.instanceId);
      await setMeta(db, "instance", init.instance);
      await setMeta(db, "state", "active");
      await new AgentSelf(db).setProfile(init.profile);
      await db.exec(`DROP TABLE ${IMPORT_MARKER}`);
    } catch (error) {
      await this.reset();
      throw error;
    }
    this.home = {
      state: "active",
      agentId: init.profile.id,
      instance: init.instance,
    };
    await this.start();
    await this.events.emit({ type: "agent.imported", data: {} });
  }

  async destroy() {
    await this.reset();
    await this.host.alarm.set(undefined);
  }

  private async reset() {
    await this.stop();
    await wipeDatabase(this.host.db);
    await this.host.blobs.clear();
    this.home = EMPTY;
    this.configured = undefined;
    this.conversation_ = undefined;
  }

  arm(extra?: Wake) {
    this.arming = this.arming
      .catch(() => {})
      .then(async () => {
        const live = this.live;
        if (!live) return this.setAlarm(undefined);
        const wake = live.harness.wake();
        const running = await this.host.db.get(
          `SELECT 1 FROM neo_turns WHERE status = 'running' LIMIT 1`,
        );
        const times: number[] = [];
        if (wake.active || extra?.active || running)
          times.push(this.now() + RECOVERY_MS);
        if (wake.at !== undefined) times.push(wake.at);
        if (extra?.at !== undefined) times.push(extra.at);
        const scheduled = await live.schedules.next();
        if (scheduled !== undefined) times.push(scheduled);
        await this.setAlarm(
          times.length ? Math.max(Math.min(...times), this.now()) : undefined,
        );
      });
    return this.arming;
  }

  private async setAlarm(at: number | undefined) {
    if (this.armed !== null && this.armed === at) return;
    this.armed = at;
    await this.host.alarm.set(at);
  }

  wake() {
    this.waking ??= (async () => {
      try {
        const live = this.live;
        if (!live) return;
        this.armed = null;
        await this.host.alarm.set(this.now() + RECOVERY_MS);
        live.harness.resume();
        await this.fireSchedules(live);
        await sweepStaging(live.vfs, this.now()).catch(() => {});
      } finally {
        this.waking = undefined;
        this.armed = null;
        await this.arm();
      }
    })();
    return this.waking;
  }

  private async fireSchedules(live: Live) {
    for (let pass = 0; pass < 10; pass++) {
      const { runs, more } = await live.schedules.fire({
        send: (input) => this.send(input),
        idle: async () =>
          !(await live.self.get()).paused &&
          !(await live.mailbox.currentTurn()) &&
          (await live.mailbox.queue()).length === 0,
        waiting: async (messageId) =>
          (await live.mailbox.message(messageId))?.status === "queued",
        timezone: () => this.timezone(),
      });
      for (const run of runs)
        await this.events.emit({
          type: "schedule.fired",
          data: {
            scheduleId: run.scheduleId,
            status: run.status,
            reason: run.reason,
            messageId: run.messageId,
          },
        });
      if (!more) return;
    }
  }

  async schedulesChanged() {
    await this.arm();
    await this.events.emit({ type: "schedule.changed", data: {} });
  }

  async conversation() {
    const live = this.services();
    let conversation = this.conversation_;
    if (!conversation) {
      const self = await live.self.get();
      if (self.conversationId !== null && isConversationId(self.conversationId))
        conversation = await live.harness.conversation(
          self.conversationId,
          this.context,
        );
      if (!conversation) {
        conversation = await live.harness.root(this.context);
        await live.self.setConversation(conversation.id);
      }
      this.conversation_ = conversation;
    }
    const config = await this.config().catch(() => undefined);
    if (!config) return conversation;
    const key = JSON.stringify([config.model, config.thinking]);
    if (this.configured !== key) {
      await conversation.configure(
        {
          model: config.model ?? null,
          thinkingLevel: config.thinking ?? null,
          cwd: "/",
        },
        this.context,
      );
      this.configured = key;
    }
    return conversation;
  }

  async send(
    input: Parameters<Mailbox["send"]>[0] & { files?: AttachmentInput[] },
  ) {
    const live = this.services();
    if (!(await this.config()).model)
      throw new SetupError("Add a model provider first (Settings → Providers)");
    const { files, ...rest } = input;
    if (files?.length) {
      const existing = rest.clientId
        ? await live.mailbox.byClientId(rest.clientId)
        : undefined;
      if (existing) return existing;
      rest.attachments = await placeUploads(live.vfs, files);
    }
    return live.mailbox.send(rest);
  }

  async answer(answer: QuestionAnswer, clientId?: string) {
    const ask = await findQuestion(
      await this.conversation(),
      answer.questionId,
    );
    if (!ask) throw new MailboxError(`No question ${answer.questionId}`);
    const known = new Set(ask.questions.map((q) => q.id));
    const unknown = Object.keys(answer.answers).find((id) => !known.has(id));
    if (unknown)
      throw new MailboxError(`The question has no item "${unknown}"`);
    const answers = Object.fromEntries(
      Object.entries(answer.answers)
        .map(([id, value]) => [id, value.trim()] as const)
        .filter(([, value]) => value),
    );
    if (Object.keys(answers).length === 0)
      throw new MailboxError("The answer is empty");
    const lines = ask.questions.flatMap((q) =>
      answers[q.id] ? [`Q: ${q.question}`, `A: ${answers[q.id]}`] : [],
    );
    return this.send({
      source: "user",
      meta: { answer: { questionId: answer.questionId, answers } },
      text: [`Answer to your question ${answer.questionId}:`, ...lines].join(
        "\n",
      ),
      ...(clientId ? { clientId } : {}),
      steer: true,
    });
  }

  upload(name: string, body: ReadableStream<Uint8Array>) {
    return stageUpload(this.services().vfs, name, body);
  }

  async pause() {
    await this.services().self.setPaused(true);
    await this.events.emit({ type: "agent.paused", data: {} });
  }

  async resume() {
    await this.services().self.setPaused(false);
    await this.events.emit({ type: "agent.resumed", data: {} });
    await this.services().mailbox.drain();
  }

  async close() {
    await this.stop();
  }

  private async setState(home: Held, state: Held["state"]) {
    this.home = { ...home, state };
    await setMeta(this.host.db, "state", state);
  }

  private async start() {
    if (this.live) return;
    const { db } = this.host;
    const vfs = new Vfs(db, this.host.blobs, this.now);
    await vfs.repair();
    const withShared = mount(
      vfs,
      SHARED_ROOT,
      remoteVfs(
        (request) => this.link().shared(request),
        (path) => this.link().sharedStream(path),
      ),
    );
    const agentVfs = readOnly(withShared, [ATTACHMENTS_ROOT]);
    const shell = new VfsShell(agentVfs);
    await this.config().catch(() => {});
    if (!this.config_) await this.catalog.rebuild([]);
    const self = new AgentSelf(db);
    const memories = new Memories(db, this.now);
    const schedules = new Schedules(db, this.now);
    const history = new History(db);

    const piDb: SqliteDatabase = {
      exec: (sql) => db.exec(sql),
      run: (sql, ...p) => db.run(sql, ...p),
      get: (sql, ...p) => db.get(sql, ...p),
      all: (sql, ...p) => db.all(sql, ...p),
      transaction: (cb) => db.transaction(cb),
      close: async () => {},
    };
    const storage = await SqliteStorage.open(piDb, { prefix: PI_PREFIX });
    const registry = createRegistry();
    const harness = await Harness.open(
      storage,
      {
        models: () => this.catalog.models(),
        registry,
        env: ({ cwd }) =>
          new VfsExecutionEnv(
            agentVfs,
            cwd ?? "/",
            `neo-vfs:${this.agentId}`,
            shell,
          ),
        identity: { attribution: { name: "neo", url: "https://github.com/" } },
        settings: {
          compaction: { enabled: true },
          afterFailedRun: "continue",
          retry: { maxRetries: 3 },
        },
        onWake: (wake) => void this.arm(wake).catch(() => {}),
        onReport: (error, info) => {
          if (info.type === "listener_error") return;
          void this.events
            .emit({
              type: "error",
              data: {
                where: info.type,
                message: error instanceof Error ? error.message : String(error),
              },
            })
            .catch(() => {});
        },
        ...(this.host.now ? { now: this.host.now } : {}),
      },
      this.context,
    );
    const mailbox = new Mailbox(
      db,
      harness,
      this.events,
      {
        conversation: () => this.conversation(),
        beforeWork: () => this.arm({ active: true }),
        turnSettled: (turn, messages) => this.turnSettled(turn, messages),
        paused: async () => (await self.get()).paused,
        timezone: () => this.timezone(),
        checkImages: async (attachments) => {
          const model = (await this.config()).model;
          const vision = model ? this.catalog.vision(model) : true;
          const inline = new Set<string>();
          const notes = new Map<string, string>();
          for (const a of attachments) {
            const check = await inlineCheck(vfs, a, vision).catch(() => ({
              inline: false as const,
              note: "not shown: it could not be read",
            }));
            if (check.inline) inline.add(a.path);
            else if (check.note) notes.set(a.path, check.note);
          }
          return { inline, notes };
        },
        readImage: async (path, mimeType) => ({
          type: "image",
          data: toBase64(await vfs.readFile(path)),
          mimeType,
        }),
      },
      this.now,
    );
    const me = async () => ({
      id: this.agentId,
      name: (await self.get()).profile.name,
      instance: this.held().instance,
    });
    const messaging = new Messaging(
      db,
      mailbox,
      me,
      (instance) => this.host.peers(instance),
      this.now,
    );
    this.live = {
      harness,
      vfs,
      self,
      memories,
      history,
      mailbox,
      messaging,
      schedules,
      watches: [],
    };

    const tools: ToolServices = {
      memories,
      history,
      mailbox,
      schedules,
      changed: () => this.schedulesChanged(),
      timezone: () => this.timezone(),
      conversation: () => this.conversation(),
      vfs: withShared,
      now: this.now,
    };
    registry.install(
      defineExtension({
        name: "files",
        tools: [
          createReadTool(),
          createWriteTool(),
          sizedEdit(createEditTool(), withShared),
          createBashTool(),
        ],
      }),
    );
    registry.install(
      defineExtension({
        name: "neo",
        sections: promptSections({
          self,
          memories,
          timezone: () => this.timezone(),
        }),
        tools: [
          ...memoryTools(tools),
          ...historyTools(tools),
          ...scheduleTools(tools),
          ...fileTools(tools),
          ...askTools(tools),
          ...teamTools({
            me,
            agents: () => this.link().agents(),
            create: async (input, key) =>
              this.link().createAgent(this.agentId, input, key),
            updateSelf: (change) =>
              this.link().updateProfile(this.agentId, change),
            messaging: () => messaging,
            interrupt: (agentId) =>
              this.host
                .peers(this.held().instance)
                .get(agentId)
                .interrupt(this.held().instance, agentId, this.agentId),
          }),
        ],
      }),
    );
    if (this.host.test) registry.install(this.host.test.extension);

    await this.watch();
    await mailbox.recover();
    await schedules.ensureSystem(
      "heartbeat",
      HEARTBEAT,
      await this.timezone().catch(() => "UTC"),
    );
    harness.resume();
    await this.arm();
    this.report();
  }

  private async watch() {
    const live = this.services();
    const conversation = await this.conversation();
    const stream = await watchEvents(
      live.harness,
      conversation.id,
      this.context,
    );
    stream.start(async (events) => {
      for (const event of events) {
        if (
          event.type === "snapshot" ||
          event.type === "agent_changed" ||
          event.type === "usage_changed"
        )
          continue;
        this.events.live("pi", event);
      }
    });
    live.watches.push(stream);
  }

  private async turnSettled(turn: Turn, messages: MailboxMessage[]) {
    const live = this.services();
    await live.messaging.turnSettled(turn, messages).catch(() => {});
    const applied = await live.memories.finish(
      turn.id,
      turn.status === "completed",
    );
    await live.history.sync(await this.conversation()).catch(() => {});
    if (applied > 0)
      await this.events.emit({
        type: "memory.changed",
        data: { turnId: turn.id, applied },
      });
    await this.arm();
  }

  private async stop() {
    const live = this.live;
    if (!live) return;
    this.armed = null;
    this.live = undefined;
    this.conversation_ = undefined;
    this.configured = undefined;
    live.mailbox.close();
    for (const watch of live.watches) await watch.stop().catch(() => {});
    await live.harness.close(this.context).catch(() => {});
    await this.setAlarm(undefined).catch(() => {});
  }
}

type EditTool = ReturnType<typeof createEditTool>;

function sizedEdit(edit: EditTool, vfs: Vfs): EditTool {
  return {
    ...edit,
    execute: async (args, api, context) => {
      const path = joinPath(api.env?.cwd ?? "/", args.path);
      const stat = await vfs.stat(path).catch(() => undefined);
      if (stat && stat.kind === "file" && stat.size > WHOLE_READ_MAX)
        throw new Error(
          `${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; edit reads whole files and is limited to ${WHOLE_READ_MAX / 1024 / 1024} MB. Read it in parts with read (offset and limit), and write a new file instead.`,
        );
      return edit.execute(args, api, context);
    },
  };
}

export { SetupError, StateError } from "./errors";
