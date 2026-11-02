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
import type { AgentMessage, AgentProfile, AgentStatus } from "@neo/client";
import { AgentSelf } from "./agent/agents";
import {
  ATTACHMENTS_ROOT,
  type AttachmentInput,
  inlineCheck,
  placeUploads,
  stageUpload,
  type Upload,
  sweepStaging,
} from "./agent/attachments";
import { fileTools } from "./agent/tools/files";
import { Mailbox, type MailboxMessage, type Turn } from "./agent/mailbox";
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
import type { AgentConfig, AgentInit, CoordinatorLink } from "./links";
import { toBase64 } from "./crypto";
import { SetupError, StateError } from "./errors";
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

/** Events that change what list_agents and the sidebar show. */
const STATUS_EVENTS = new Set([
  "message.queued",
  "message.cancelled",
  "message.steered",
  "message.requeued",
  "turn.started",
  "turn.ended",
  "agent.paused",
  "agent.resumed",
]);

/** One agent: its queue, turns, memory, schedules and workspace. A host runs one per agent. */
export class NeoAgent {
  readonly events: Events;
  readonly now: () => number;
  readonly catalog = new ModelCatalog();
  private live: Live | undefined;
  private state_: InstanceState = "empty";
  private agentId_: string | undefined;
  private instance_: string | undefined;
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
          .cancelled(String(event.data.messageId))
          .catch(() => {});
    });
  }

  static async open(host: AgentPorts): Promise<NeoAgent> {
    const agent = new NeoAgent(host);
    if (await hasTable(host.db, IMPORT_MARKER)) {
      await wipeDatabase(host.db);
      await host.blobs.clear();
    }
    if (await hasTable(host.db, "neo_meta")) {
      agent.agentId_ = await getMeta(host.db, "agent_id");
      agent.instance_ = await getMeta(host.db, "instance");
      agent.state_ =
        ((await getMeta(host.db, "state")) as InstanceState | undefined) ??
        "empty";
    }
    if (agent.state_ === "active") await agent.start();
    return agent;
  }

  get state(): InstanceState {
    return this.state_;
  }

  get agentId(): string {
    if (!this.agentId_) throw new StateError("empty", "No such agent");
    return this.agentId_;
  }

  services(): Live {
    if (!this.live)
      throw new StateError(this.state_, `The agent is ${this.state_}`);
    return this.live;
  }

  fetch(request: Request): Promise<Response> {
    return handleAgentApi(this, request);
  }

  private link(): CoordinatorLink {
    if (!this.instance_) throw new StateError(this.state_, "No such agent");
    return this.host.coordinator(this.instance_);
  }

  /** A request for an agent this DO has not made yet: ask the registry whether it exists. */
  async claim(address: Address): Promise<boolean> {
    if (this.state_ !== "empty") return true;
    const init = await this.host
      .coordinator(address.instance)
      .init(address.agentId);
    if (!init) return false;
    await this.provision(init);
    return true;
  }

  /** Makes this agent (idempotent: a made agent only takes the newer profile and name). */
  async provision(init: AgentInit): Promise<void> {
    const { db } = this.host;
    if (this.state_ !== "empty") {
      if (this.agentId_ !== init.profile.id)
        throw new StateError(this.state_, "This home holds another agent");
      await this.setInstance(init.instance);
      if (this.live) await this.live.self.setProfile(init.profile);
      return;
    }
    await createAgentSchema(db);
    await setMeta(db, "agent_id", init.profile.id);
    await setMeta(db, "instance_id", init.instanceId);
    await setMeta(db, "instance", init.instance);
    await setMeta(db, "created_at", String(this.now()));
    await new AgentSelf(db).init(init.profile);
    this.agentId_ = init.profile.id;
    this.instance_ = init.instance;
    await this.setState("active");
    await this.start();
  }

  private async setInstance(instance: string): Promise<void> {
    if (this.instance_ === instance) return;
    this.instance_ = instance;
    await setMeta(this.host.db, "instance", instance);
  }

  async profileChanged(profile: AgentProfile): Promise<void> {
    if (this.agentId_ !== profile.id) return;
    await new AgentSelf(this.host.db).setProfile(profile);
    if (this.live) await this.live.self.setProfile(profile);
    await this.events.emit("agent.changed", {});
  }

  /** The instance's providers, model and timezone; fetched when stale, held in memory only. */
  async config(): Promise<AgentConfig> {
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

  async configChanged(revision: number): Promise<void> {
    if (this.config_ && revision <= this.config_.revision) return;
    this.stale = true;
    if (this.live) await this.config().catch(() => {});
  }

  async timezone(): Promise<string> {
    return (await this.config()).timezone;
  }

  async status(): Promise<AgentStatus | undefined> {
    const live = this.live;
    if (!live) return undefined;
    return {
      working: !!(await live.mailbox.currentTurn()),
      queued: (await live.mailbox.queue()).length,
      paused: (await live.self.get()).paused,
      at: this.now(),
    };
  }

  /** Tells the coordinator what this agent is doing (one report in flight; the last one wins). */
  private report(): void {
    if (this.reporting) {
      this.reportAgain = true;
      return;
    }
    this.reporting = (async () => {
      do {
        this.reportAgain = false;
        const status = await this.status().catch(() => undefined);
        if (status && this.agentId_)
          await this.link()
            .report(this.agentId_, status)
            .catch(() => {});
      } while (this.reportAgain);
    })().finally(() => {
      this.reporting = undefined;
    });
  }

  /** A message from a teammate. An agent nobody has opened yet makes itself first. */
  async deliver(message: AgentMessage): Promise<void> {
    if (this.state_ === "empty")
      await this.claim({ instance: message.instance, agentId: message.to });
    if (this.state_ === "empty") throw new Error(`No agent ${message.to}`);
    if (this.state_ !== "active")
      throw new StateError(
        this.state_,
        `${message.to} is not taking messages right now (${this.state_})`,
      );
    await this.services().messaging.deliver(message);
  }

  /** A teammate stops what it asked of this agent. */
  async interrupt(
    address: Address,
    from: string,
  ): Promise<{ stopped: boolean; cancelled: number }> {
    if (this.state_ === "empty") await this.claim(address);
    const live = this.services();
    await live.messaging.closeFrom(from);
    const fromThem = (m: MailboxMessage) =>
      m.source === "agent" &&
      (m.meta.from as { id?: string } | undefined)?.id === from;
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

  async isNew(): Promise<boolean> {
    if (this.state_ === "empty") return true;
    if (this.state_ !== "active") return false;
    const used = await this.host.db.get(
      `SELECT 1 FROM neo_mailbox UNION ALL SELECT 1 FROM neo_memories UNION ALL SELECT 1 FROM vfs_nodes WHERE kind = 'file' LIMIT 1`,
    );
    return used === undefined;
  }

  async seal(): Promise<void> {
    if (this.state_ === "sealed") return;
    if (this.state_ !== "active")
      throw new StateError(this.state_, `The agent is ${this.state_}`);
    await this.stop();
    await this.setState("sealed");
    await this.events.emit("instance.sealed");
  }

  async unseal(): Promise<void> {
    if (this.state_ === "active") return;
    if (this.state_ !== "sealed")
      throw new StateError(this.state_, "The agent is not sealed");
    await this.setState("active");
    await this.start();
    await this.events.emit("instance.unsealed");
  }

  async markMoved(): Promise<void> {
    if (this.state_ === "moved") return;
    if (this.state_ !== "sealed")
      throw new StateError(this.state_, "Seal and export the agent first");
    await this.setState("moved");
  }

  exportPart(): ReadableStream<Uint8Array> {
    if (this.state_ !== "sealed" && this.state_ !== "moved")
      throw new StateError(this.state_, "Seal the agent before exporting it");
    return encodeNdjson(writePart(this.host.db, this.host.blobs));
  }

  /** Replaces this agent with one part of a bundle. A failure leaves it empty. */
  async importPart(
    init: AgentInit,
    part: ReadableStream<Uint8Array>,
  ): Promise<void> {
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
    this.agentId_ = init.profile.id;
    this.instance_ = init.instance;
    this.state_ = "active";
    await this.start();
    await this.events.emit("instance.imported", {});
  }

  /** Removes the agent: its database, its files and its alarm. */
  async destroy(): Promise<void> {
    await this.reset();
    await this.host.alarm.set(undefined);
  }

  private async reset(): Promise<void> {
    await this.stop();
    await wipeDatabase(this.host.db);
    await this.host.blobs.clear();
    this.state_ = "empty";
    this.agentId_ = undefined;
    this.configured = undefined;
    this.conversation_ = undefined;
  }

  arm(extra?: Wake): Promise<void> {
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

  private async setAlarm(at: number | undefined): Promise<void> {
    if (this.armed !== null && this.armed === at) return;
    this.armed = at;
    await this.host.alarm.set(at);
  }

  wake(): Promise<void> {
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

  private async fireSchedules(live: Live): Promise<void> {
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
        await this.events.emit("schedule.fired", {
          scheduleId: run.scheduleId,
          status: run.status,
          reason: run.reason,
          messageId: run.messageId,
        });
      if (!more) return;
    }
  }

  async schedulesChanged(): Promise<void> {
    await this.arm();
    await this.events.emit("schedule.changed", {});
  }

  async conversation(): Promise<Conversation> {
    const live = this.services();
    let conversation = this.conversation_;
    if (!conversation) {
      const self = await live.self.get();
      if (self.conversationId !== null)
        conversation = await live.harness.conversation(
          self.conversationId as never,
          this.context,
        );
      if (!conversation) {
        conversation = await live.harness.root(this.context);
        await live.self.setConversation(conversation.id as unknown as number);
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
  ): Promise<MailboxMessage> {
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

  upload(name: string, body: ReadableStream<Uint8Array>): Promise<Upload> {
    return stageUpload(this.services().vfs, name, body);
  }

  async pause(): Promise<void> {
    await this.services().self.setPaused(true);
    await this.events.emit("agent.paused", {});
  }

  async resume(): Promise<void> {
    await this.services().self.setPaused(false);
    await this.events.emit("agent.resumed", {});
    await this.services().mailbox.drain();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private async setState(state: InstanceState): Promise<void> {
    this.state_ = state;
    await setMeta(this.host.db, "state", state);
  }

  private async start(): Promise<void> {
    if (this.live) return;
    const { db } = this.host;
    const vfs = new Vfs(db, this.host.blobs, this.now);
    await vfs.repair();
    // The agent sees the instance's /shared too; its tools may not change attachments
    // (history points at them). The person's APIs use `vfs`, without /shared.
    const withShared = mount(
      vfs,
      SHARED_ROOT,
      remoteVfs(
        (op, args) => this.link().shared(op, args),
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
            `neo-vfs:${this.agentId_}`,
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
            .emit("error", {
              where: info.type,
              message: error instanceof Error ? error.message : String(error),
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
      instance: this.instance_!,
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
                .peers(this.instance_!)
                .get(agentId)
                .interrupt(this.instance_!, agentId, this.agentId),
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

  private async watch(): Promise<void> {
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

  private async turnSettled(
    turn: Turn,
    messages: MailboxMessage[],
  ): Promise<void> {
    const live = this.services();
    await live.messaging.turnSettled(turn, messages).catch(() => {});
    const applied = await live.memories.finish(
      turn.id,
      turn.status === "completed",
    );
    await live.history.sync(await this.conversation()).catch(() => {});
    if (applied > 0)
      await this.events.emit("memory.changed", { turnId: turn.id, applied });
    await this.arm();
  }

  private async stop(): Promise<void> {
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

function sizedEdit<T extends { execute: (...args: any[]) => any }>(
  edit: T,
  vfs: Vfs,
): T {
  return {
    ...edit,
    execute: async (
      args: { path?: string },
      api: { env?: { cwd?: string } },
      context: unknown,
    ) => {
      if (typeof args.path === "string") {
        const path = joinPath(api.env?.cwd ?? "/", args.path);
        const stat = await vfs.stat(path).catch(() => undefined);
        if (stat && stat.kind === "file" && stat.size > WHOLE_READ_MAX)
          throw new Error(
            `${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; edit reads whole files and is limited to ${WHOLE_READ_MAX / 1024 / 1024} MB. Read it in parts with read (offset and limit), and write a new file instead.`,
          );
      }
      return edit.execute(args, api, context);
    },
  };
}

export { SetupError, StateError } from "./errors";
