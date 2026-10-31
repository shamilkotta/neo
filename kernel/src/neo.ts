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
  type ModelRef,
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
import { type AgentRecord, Agents, DEFAULT_AGENT_ID } from "./agent/agents";
import { Mailbox, type MailboxMessage, type Turn } from "./agent/mailbox";
import { promptSections } from "./agent/prompt";
import { historyTools } from "./agent/tools/history";
import { memoryTools } from "./agent/tools/memory";
import type { ToolServices } from "./agent/tools/shared";
import { scheduleTools } from "./agent/tools/schedules";
import { HEARTBEAT, Schedules } from "./agent/schedules";
import { handleApi } from "./api";
import type { HostPorts } from "./host";
import { toBase64 } from "./crypto";
import {
  BLOB_PIECE,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleError,
  type BundleHeader,
  type BundleRecord,
  decodeBundle,
  encodeBundle,
  readBundle,
  unwrapDek,
  wrapDek,
} from "./move/bundle";
import { dumpDatabase, loadDatabase, wipeDatabase } from "./move/snapshot";
import { createSchema, getMeta, hasTable, setMeta } from "./schema";
import { Events } from "./services/events";
import { History } from "./services/history";
import { Memories } from "./services/memory";
import { Providers } from "./services/providers";
import { Secrets } from "./services/secrets";
import { Settings } from "./services/settings";
import type { SqliteDatabase } from "./sql";
import { VfsShell } from "./vfs/bash";
import { measured } from "./vfs/blobs";
import { VfsExecutionEnv } from "./vfs/env";
import { joinPath, rechunk, Vfs, WHOLE_READ_MAX } from "./vfs/vfs";

export const NEO_VERSION = "0.1.0";
/** Pi's tables share the instance database under this prefix. */
export const PI_PREFIX = "pi_";
/** While work runs, the alarm rings at least this often, so a host that dies mid-turn is woken to resume it. */
export const RECOVERY_MS = 60_000;
/** Exists only while an import loads (host_* never travels): a host that finds it at open wipes the half-load. */
const IMPORT_MARKER = "host_import";

/**
 * The lifecycle of an instance on a host. Only `active` runs. A move seals the source (`sealed`:
 * nothing runs, ready to export), imports it elsewhere, then retires the source (`moved`). `empty`
 * is only seen while an import loads.
 */
export type InstanceState = "empty" | "active" | "sealed" | "moved";

/** The running services of an active instance. */
export interface Live {
  harness: Harness;
  vfs: Vfs;
  secrets: Secrets;
  providers: Providers;
  settings: Settings;
  agents: Agents;
  memories: Memories;
  history: History;
  mailbox: Mailbox;
  schedules: Schedules;
  watches: AgentEventStream[];
}

/**
 * One Neo instance on one host. Everything durable is in the host's database (and blob store);
 * this object only holds connections and caches, so the same instance continues on any host that
 * opens its data.
 */
export class Neo {
  readonly events: Events;
  readonly now: () => number;
  private live: Live | undefined;
  private state_: InstanceState = "empty";
  private instanceId_: string | undefined;
  private readonly context: Context = BACKGROUND_CONTEXT;
  /** The alarm time last set, so an unchanged time is not written again (a DO write each time). */
  private armed: number | undefined | null = null;
  private arming: Promise<void> = Promise.resolve();
  private waking: Promise<void> | undefined;
  /** What each agent's conversation was last configured with. */
  private readonly configured = new Map<string, string>();
  private readonly conversationAgents = new Map<number, string>();

  private constructor(readonly host: HostPorts) {
    this.now = host.now ?? Date.now;
    this.events = new Events(host.db, this.now);
  }

  static async open(host: HostPorts): Promise<Neo> {
    const neo = new Neo(host);
    if (await hasTable(host.db, IMPORT_MARKER)) {
      // An import stopped part way (crash, eviction): start again from nothing.
      await wipeDatabase(host.db);
      await host.blobs.clear();
    }
    if (await hasTable(host.db, "neo_meta")) {
      neo.instanceId_ = await getMeta(host.db, "instance_id");
      neo.state_ =
        ((await getMeta(host.db, "state")) as InstanceState | undefined) ??
        "empty";
    } else {
      // A new host: a new instance. (A host that waits for an import will skip this.)
      await neo.init();
      return neo;
    }
    if (neo.state_ === "active") await neo.start();
    return neo;
  }

  get state(): InstanceState {
    return this.state_;
  }

  get instanceId(): string | undefined {
    return this.instanceId_;
  }

  /** How many times the instance has moved, plus one: each import takes the next. */
  async epoch(): Promise<number | undefined> {
    if (this.state_ === "empty") return undefined;
    const value = await getMeta(this.host.db, "epoch").catch(() => undefined);
    return value === undefined ? undefined : Number(value);
  }

  /** The running services; throws unless the instance is active. */
  services(): Live {
    if (!this.live)
      throw new StateError(this.state_, `The instance is ${this.state_}`);
    return this.live;
  }

  fetch(request: Request): Promise<Response> {
    return handleApi(this, request);
  }

  /** Creates a new instance in an empty database. */
  async init(): Promise<void> {
    if (this.state_ !== "empty")
      throw new StateError(this.state_, "This host already holds an instance");
    await createSchema(this.host.db);
    this.instanceId_ = crypto.randomUUID();
    await setMeta(this.host.db, "instance_id", this.instanceId_);
    await setMeta(this.host.db, "created_at", String(this.now()));
    await setMeta(this.host.db, "epoch", "1");
    if (this.host.timezone)
      await new Settings(this.host.db).update({ timezone: this.host.timezone });
    await this.setState("active");
    await this.start();
  }

  // ---- moving ----------------------------------------------------------------------------------

  /**
   * Stops all work so the instance can be exported: nothing drains, no schedule fires, and Pi stops
   * its run at the next commit (aborting nothing that isn't replayed). A running turn stays
   * `running`, and resumes wherever the instance opens next.
   */
  async seal(): Promise<void> {
    if (this.state_ !== "active")
      throw new StateError(
        this.state_,
        `Only an active instance can be sealed (it is ${this.state_})`,
      );
    await this.stop();
    await this.setState("sealed");
    await this.events.emit("instance.sealed");
  }

  /** Cancels a move: the sealed instance runs here again. */
  async unseal(): Promise<void> {
    if (this.state_ !== "sealed")
      throw new StateError(this.state_, "The instance is not sealed");
    await this.setState("active");
    await this.start();
    await this.events.emit("instance.unsealed");
  }

  /** The target confirmed the import: this copy is retired and never runs again. */
  async markMoved(): Promise<void> {
    if (this.state_ !== "sealed")
      throw new StateError(this.state_, "Seal and export the instance first");
    await this.setState("moved");
  }

  /**
   * The sealed instance as a `.neo` bundle, streamed. With a passphrase the bundle carries the
   * data key, so secrets (provider keys) keep working on the target; without one they are dropped.
   */
  async exportBundle(passphrase?: string): Promise<ReadableStream<Uint8Array>> {
    if (this.state_ !== "sealed" && this.state_ !== "moved")
      throw new StateError(this.state_, "Seal the instance before exporting it");
    const { db, blobs } = this.host;
    const secrets = new Secrets(db, this.host.masterKey, this.now);
    await secrets.init();
    const header: BundleHeader = {
      t: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      instanceId: this.instanceId_!,
      epoch: Number((await getMeta(db, "epoch")) ?? 1) + 1,
      createdAt: this.now(),
      source: { host: this.host.name },
      ...(passphrase ? { dek: await wrapDek(secrets.rawDek(), passphrase) } : {}),
    };
    async function* records(): AsyncGenerator<BundleRecord> {
      yield header;
      let count = 0;
      for await (const record of dumpDatabase(db)) {
        // The data key at rest is wrapped by this host's master key; the header carries it instead.
        if (record.t === "rows" && record.table === "neo_meta") {
          const key = record.columns.indexOf("key");
          record.rows = record.rows.filter((row) => row[key] !== "dek");
        }
        count++;
        yield record;
      }
      // The bytes of large files, one object at a time, in pieces.
      for (let after = ""; ; ) {
        const page = await db.all<{ key: string; size: number; hash: string }>(
          `SELECT key, size, hash FROM vfs_blobs WHERE key > ? ORDER BY key LIMIT 100`,
          after,
        );
        if (page.length === 0) break;
        for (const blob of page) {
          const stream = await blobs.get(blob.key);
          if (!stream)
            throw new Error(`A file's content is missing (${blob.key})`);
          count++;
          yield { t: "blob", ...blob };
          for await (const piece of rechunk(stream, BLOB_PIECE)) {
            count++;
            yield { t: "blob-data", data: toBase64(piece) };
          }
          count++;
          yield { t: "blob-end" };
        }
        after = page.at(-1)!.key;
      }
      yield { t: "end", records: count };
    }
    return encodeBundle(records());
  }

  /**
   * Loads a bundle in place of this host's instance, which must be new (no messages, providers,
   * memories or files): a host makes one on first open, so that is what a move target holds. A
   * host the instance moved away from (`moved`) takes it back from a later epoch. The
   * instance then runs here with the next epoch, and resumes a turn that was running at the seal.
   */
  async importBundle(
    body: ReadableStream<Uint8Array>,
    passphrase?: string,
  ): Promise<{ instanceId: string; epoch: number; secrets: "kept" | "dropped" }> {
    const homecoming = this.state_ === "moved";
    if (!homecoming && this.state_ !== "empty" && !(await this.isNew()))
      throw new StateError(
        this.state_,
        "Import needs a new instance (this one has been used)",
      );
    const bundle = await readBundle(decodeBundle(body)[Symbol.asyncIterator]());
    // A retired copy takes back only its own instance, from a later move.
    if (
      homecoming &&
      (bundle.header.instanceId !== this.instanceId_ ||
        bundle.header.epoch <= ((await this.epoch()) ?? 0))
    )
      throw new StateError(
        this.state_,
        "This host retired another instance (or a later copy of this one)",
      );
    if (bundle.header.dek && !passphrase)
      throw new BundleError("This bundle's secrets need its passphrase");
    // Check the passphrase before touching anything.
    const dek =
      bundle.header.dek && passphrase
        ? await unwrapDek(bundle.header.dek, passphrase)
        : undefined;
    const { db } = this.host;
    await this.stop();
    this.state_ = "empty";
    this.instanceId_ = undefined;
    this.configured.clear();
    this.conversationAgents.clear();
    await wipeDatabase(db);
    await this.host.blobs.clear();
    await db.exec(`CREATE TABLE ${IMPORT_MARKER} (started_at INTEGER) STRICT`);
    try {
      await loadDatabase(db, bundle.main());
      for await (const blob of bundle.blobs()) {
        const body = measured(
          blob.stream,
          Number.MAX_SAFE_INTEGER,
          () => new Error(),
        );
        await this.host.blobs.put(blob.key, body.stream);
        const got = body.result();
        if (got.size !== blob.size || got.hash !== blob.hash)
          throw new BundleError(
            `The bundle is damaged: a file's content does not match (${blob.key})`,
          );
      }
      await bundle.end();
      if ((await getMeta(db, "instance_id")) !== bundle.header.instanceId)
        throw new BundleError("The bundle's header and data disagree");
      const secrets = new Secrets(db, this.host.masterKey, this.now);
      if (dek) await secrets.storeDek(dek);
      // Without the key the stored secrets are unreadable; a new key is made on start.
      else await db.run(`DELETE FROM neo_secrets`);
      await setMeta(db, "epoch", String(bundle.header.epoch));
      await setMeta(db, "state", "active");
      await db.exec(`DROP TABLE ${IMPORT_MARKER}`);
    } catch (error) {
      // Back to a new instance, as if the import never started.
      await wipeDatabase(db);
      await this.host.blobs.clear();
      await this.init();
      throw error;
    }
    this.instanceId_ = bundle.header.instanceId;
    this.state_ = "active";
    await this.start();
    await this.events.emit("instance.imported", {
      from: bundle.header.source.host,
      epoch: bundle.header.epoch,
    });
    return {
      instanceId: this.instanceId_,
      epoch: bundle.header.epoch,
      secrets: dek ? "kept" : "dropped",
    };
  }

  /** Nothing in it yet a person made: an import may replace it. */
  private async isNew(): Promise<boolean> {
    if (this.state_ !== "active") return false;
    const used = await this.host.db.get(
      `SELECT 1 FROM neo_mailbox UNION ALL SELECT 1 FROM neo_providers UNION ALL SELECT 1 FROM neo_memories UNION ALL SELECT 1 FROM vfs_nodes WHERE kind = 'file' LIMIT 1`,
    );
    return used === undefined;
  }

  // ---- time ------------------------------------------------------------------------------------

  /**
   * Sets the host's alarm to the earliest thing that needs a process: Pi's next sleep, a recovery
   * ring while work runs, and the next schedule (reminders, routines and the heartbeat are all
   * schedules). Calls are serialized; an unchanged time is not set again.
   */
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

  /** The host's alarm rang: resume Pi, fire what is due, then arm again. */
  wake(): Promise<void> {
    this.waking ??= (async () => {
      try {
        const live = this.live;
        if (!live) return;
        // A recovery ring first, in case this wake is cut off (a Durable Object can be evicted).
        this.armed = null;
        await this.host.alarm.set(this.now() + RECOVERY_MS);
        live.harness.resume();
        await this.fireSchedules(live);
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
        send: (agentId, input) => this.send(agentId, input),
        idle: async (agentId) =>
          !(await live.agents.get(agentId)).paused &&
          !(await live.mailbox.currentTurn(agentId)) &&
          (await live.mailbox.queue(agentId)).length === 0,
        waiting: async (messageId) =>
          (await live.mailbox.message(messageId))?.status === "queued",
        timezone: () => live.settings.get("timezone"),
      });
      for (const run of runs)
        await this.events.emit(
          "schedule.fired",
          {
            scheduleId: run.scheduleId,
            status: run.status,
            reason: run.reason,
            messageId: run.messageId,
          },
          run.agentId,
        );
      if (!more) return;
    }
  }

  /** A schedule changed: the alarm follows, and clients reload. */
  async schedulesChanged(agentId: string): Promise<void> {
    await this.arm();
    await this.events.emit("schedule.changed", {}, agentId);
  }

  /** The person's timezone changed: wall-clock schedules move with it. */
  async timezoneChanged(): Promise<void> {
    const live = this.services();
    await live.schedules.retime(await live.settings.get("timezone"));
    await this.arm();
  }

  // ---- agent ---------------------------------------------------------------------------------

  /** The agent's conversation, configured with its current model, thinking level and instructions. */
  async conversation(agentId: string): Promise<Conversation> {
    const live = this.services();
    const agent = await live.agents.get(agentId);
    let conversation: Conversation | undefined;
    if (agent.conversationId !== null)
      conversation = await live.harness.conversation(
        agent.conversationId as never,
        this.context,
      );
    if (!conversation) {
      // The default agent's chat is Pi's root conversation.
      conversation = await live.harness.root(this.context);
      await live.agents.setConversation(
        agentId,
        conversation.id as unknown as number,
      );
    }
    this.conversationAgents.set(conversation.id as unknown as number, agentId);
    const model = agent.model ?? (await this.defaultModel());
    const config = JSON.stringify([model, agent.thinking]);
    if (this.configured.get(agentId) !== config) {
      await conversation.configure(
        {
          model: model ?? null,
          thinkingLevel: agent.thinking ?? null,
          cwd: "/",
        },
        this.context,
      );
      this.configured.set(agentId, config);
    }
    return conversation;
  }

  /** The model an agent without its own uses: the first available one. */
  async defaultModel(): Promise<ModelRef | undefined> {
    const live = this.services();
    if (this.host.test) return { provider: "faux", modelId: "m" };
    const available = await live.providers.available();
    const first = available[0];
    return first ? { provider: first.provider, modelId: first.id } : undefined;
  }

  async agentOf(conversationId: number): Promise<string> {
    const known = this.conversationAgents.get(conversationId);
    if (known) return known;
    const row = await this.host.db.get<{ id: string }>(
      `SELECT id FROM neo_agents WHERE conversation_id = ?`,
      conversationId,
    );
    if (!row) throw new Error("This conversation belongs to no agent");
    this.conversationAgents.set(conversationId, row.id);
    return row.id;
  }

  async agent(id = DEFAULT_AGENT_ID): Promise<AgentRecord> {
    return this.services().agents.get(id);
  }

  /** Sends a message to the agent, after checking it has a model. */
  async send(
    agentId: string,
    input: Parameters<Mailbox["send"]>[1],
  ): Promise<MailboxMessage> {
    const live = this.services();
    const agent = await live.agents.get(agentId);
    if (!agent.model && !(await this.defaultModel()))
      throw new SetupError("Add a model provider first (Settings → Providers)");
    return live.mailbox.send(agentId, input);
  }

  async pause(agentId: string): Promise<void> {
    await this.services().agents.setPaused(agentId, true);
    await this.events.emit("agent.paused", {}, agentId);
  }

  async resume(agentId: string): Promise<void> {
    await this.services().agents.setPaused(agentId, false);
    await this.events.emit("agent.resumed", {}, agentId);
    await this.services().mailbox.drain(agentId);
  }

  async close(): Promise<void> {
    await this.stop();
  }

  // ---- internals -----------------------------------------------------------------------------

  private async setState(state: InstanceState): Promise<void> {
    this.state_ = state;
    await setMeta(this.host.db, "state", state);
  }

  private async start(): Promise<void> {
    if (this.live) return;
    const { db } = this.host;
    const vfs = new Vfs(db, this.host.blobs, this.now);
    await vfs.repair();
    const shell = new VfsShell(vfs);
    const secrets = new Secrets(db, this.host.masterKey, this.now);
    await secrets.init();
    const providers = new Providers(db, secrets, this.now);
    if (this.host.test) providers.addHostProvider(this.host.test.provider);
    await providers.rebuild();
    const settings = new Settings(db);
    const agents = new Agents(db, this.now);
    await agents.ensure();
    const memories = new Memories(db, this.now);
    const schedules = new Schedules(db, this.now);
    const history = new History(db);

    // Pi closes its storage's database on close; Neo owns the database, so Pi's handle does not.
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
        models: () => providers.models(),
        registry,
        env: ({ cwd }) =>
          new VfsExecutionEnv(
            vfs,
            cwd ?? "/",
            `neo-vfs:${this.instanceId_}`,
            shell,
          ),
        identity: { attribution: { name: "neo", url: "https://github.com/" } },
        settings: {
          compaction: { enabled: true },
          // A failed turn must not hold the messages behind it (Neo's queue is separate anyway).
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
        conversation: (agentId) => this.conversation(agentId),
        beforeWork: () => this.arm({ active: true }),
        turnSettled: (turn, messages) => this.turnSettled(turn, messages),
        paused: async (agentId) => (await agents.get(agentId)).paused,
        timezone: () => settings.get("timezone"),
      },
      this.now,
    );
    this.live = {
      harness,
      vfs,
      secrets,
      providers,
      settings,
      agents,
      memories,
      history,
      mailbox,
      schedules,
      watches: [],
    };

    const tools: ToolServices = {
      memories,
      history,
      mailbox,
      schedules,
      changed: (agentId) => this.schedulesChanged(agentId),
      settings,
      agentOf: (id) => this.agentOf(id),
      conversation: (agentId) => this.conversation(agentId),
      now: this.now,
    };
    registry.install(
      defineExtension({
        name: "files",
        tools: [
          createReadTool(),
          createWriteTool(),
          sizedEdit(createEditTool(), vfs),
          createBashTool(),
        ],
      }),
    );
    registry.install(
      defineExtension({
        name: "neo",
        sections: promptSections({
          agents,
          memories,
          settings,
          agentOf: (id) => this.agentOf(id),
        }),
        tools: [
          ...memoryTools(tools),
          ...historyTools(tools),
          ...scheduleTools(tools),
        ],
      }),
    );
    if (this.host.test) registry.install(this.host.test.extension);

    for (const agent of await agents.list()) {
      await this.watch(agent.id);
      await mailbox.recover(agent.id);
      await schedules.ensureSystem(
        agent.id,
        "heartbeat",
        HEARTBEAT,
        await settings.get("timezone"),
      );
    }
    harness.resume();
    await this.arm();
  }

  /** Streams the agent's running turn (text deltas, tool steps) to connected clients. */
  private async watch(agentId: string): Promise<void> {
    const live = this.services();
    const conversation = await this.conversation(agentId);
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
        this.events.live("pi", event, agentId);
      }
    });
    live.watches.push(stream);
  }

  private async turnSettled(
    turn: Turn,
    _messages: MailboxMessage[],
  ): Promise<void> {
    const live = this.services();
    const applied = await live.memories.finish(
      turn.id,
      turn.status === "completed",
    );
    // The turn's messages become searchable now, a page at a time, never all at once.
    await live.history
      .sync(turn.agentId, await this.conversation(turn.agentId))
      .catch(() => {});
    if (applied > 0)
      await this.events.emit(
        "memory.changed",
        { turnId: turn.id, applied },
        turn.agentId,
      );
    await this.arm();
  }

  private async stop(): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.armed = null;
    this.live = undefined;
    live.mailbox.close();
    for (const watch of live.watches) await watch.stop().catch(() => {});
    await live.harness.close(this.context).catch(() => {});
    await this.setAlarm(undefined).catch(() => {});
  }
}

/**
 * `edit` reads the whole file, and Pi's tool reports a refused read only by its error code. This
 * checks the size first, so the model learns why and reads the file in parts instead.
 */
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

export class StateError extends Error {
  constructor(
    readonly state: InstanceState,
    message: string,
  ) {
    super(message);
  }
}

/** Something the person has to set up first. */
export class SetupError extends Error {}
