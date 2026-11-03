import type {
  AgentId,
  AgentProfile,
  AgentStatus,
  NewAgent,
  ProfileChange,
  SettingsShape,
} from "@neo/client";
import type { CoordinatorPorts } from "../host";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleError,
  type BundleHeader,
  type BundleRecord,
  decodeBundle,
  decodeNdjson,
  encodeBundle,
  forwardPart,
  readHeader,
  readPart,
  unwrapDek,
  wrapDek,
  writePart,
} from "../move/bundle";
import { wipeDatabase } from "../move/snapshot";
import { storedState } from "../errors";
import { IMPORT_MARKER, type InstanceState, StateError } from "../neo";
import { createCoordinatorSchema, getMeta, hasTable, setMeta } from "../schema";
import { Events } from "../services/events";
import { ModelCatalog, ProviderStore } from "../services/providers";
import type { ProviderConfig } from "../services/providers";
import { Secrets } from "../services/secrets";
import { Settings } from "../services/settings";
import { TEST_MODEL } from "../testing";
import { serveShared, type SharedRequest } from "../vfs/mount";
import { Vfs } from "../vfs/vfs";
import { handleCoordinatorApi } from "./api";
import { Registry, RegistryError } from "./registry";

interface Services {
  shared: Vfs;
  settings: Settings;
  secrets: Secrets;
  providers: ProviderStore;
  registry: Registry;
}

export class NeoCoordinator {
  readonly events: Events;
  readonly now: () => number;
  readonly catalog = new ModelCatalog();
  private live: Services | undefined;
  private state_: InstanceState = "empty";
  private instanceId_: string | undefined;
  private instance_: string | undefined;

  private constructor(readonly host: CoordinatorPorts) {
    this.now = host.now ?? Date.now;
    this.events = new Events(host.db, this.now);
  }

  static async open(host: CoordinatorPorts) {
    const coordinator = new NeoCoordinator(host);
    if (await hasTable(host.db, IMPORT_MARKER)) {
      await wipeDatabase(host.db);
      await host.blobs.clear();
    }
    if (!(await hasTable(host.db, "neo_meta"))) {
      await coordinator.init();
      return coordinator;
    }
    coordinator.instanceId_ = await getMeta(host.db, "instance_id");
    coordinator.instance_ = await getMeta(host.db, "instance");
    coordinator.state_ = storedState(await getMeta(host.db, "state"));
    await coordinator.start();
    return coordinator;
  }

  get state() {
    return this.state_;
  }

  get instanceId() {
    return this.instanceId_;
  }

  async epoch() {
    const value = await getMeta(this.host.db, "epoch").catch(() => undefined);
    return value === undefined ? undefined : Number(value);
  }

  services() {
    if (!this.live) throw new StateError(this.state_, "The instance is empty");
    return this.live;
  }

  fetch(request: Request) {
    return handleCoordinatorApi(this, request);
  }

  async setInstance(name: string) {
    if (this.instance_ === name) return;
    this.instance_ = name;
    await setMeta(this.host.db, "instance", name);
  }

  private instance() {
    if (!this.instance_)
      throw new StateError(this.state_, "The instance has no name yet");
    return this.instance_;
  }

  private activeInstanceId() {
    if (!this.instanceId_)
      throw new StateError(this.state_, "The instance has no id yet");
    return this.instanceId_;
  }

  private cell(agentId: AgentId) {
    return this.host.cells(this.instance()).get(agentId);
  }

  private async init() {
    const { db } = this.host;
    await createCoordinatorSchema(db);
    this.instanceId_ = crypto.randomUUID();
    await setMeta(db, "instance_id", this.instanceId_);
    await setMeta(db, "created_at", String(this.now()));
    await setMeta(db, "epoch", "1");
    await setMeta(db, "revision", "1");
    if (this.instance_) await setMeta(db, "instance", this.instance_);
    if (this.host.timezone)
      await new Settings(db).update({ timezone: this.host.timezone });
    await this.setState("active");
    await this.start();
    await this.services().registry.ensurePrimary();
  }

  private async start() {
    const { db } = this.host;
    const secrets = new Secrets(db, this.host.masterKey, this.now);
    await secrets.init();
    const providers = new ProviderStore(db, secrets, this.now);
    const shared = new Vfs(db, this.host.blobs, this.now);
    await shared.repair();
    this.live = {
      shared,
      settings: new Settings(db),
      secrets,
      providers,
      registry: new Registry(db, this.now),
    };
    await this.catalog.rebuild(await providers.resolved());
  }

  private async setState(state: InstanceState) {
    this.state_ = state;
    await setMeta(this.host.db, "state", state);
  }

  async agentInit(agentId: AgentId) {
    if (this.state_ !== "active") return undefined;
    const profile = await this.services().registry.get(agentId);
    return profile ? this.initOf(profile) : undefined;
  }

  private initOf(profile: AgentProfile) {
    return {
      instance: this.instance(),
      instanceId: this.activeInstanceId(),
      profile,
    };
  }

  async agentConfig() {
    const live = this.services();
    const settings = await live.settings.all();
    return {
      revision: Number((await getMeta(this.host.db, "revision")) ?? 1),
      providers: await live.providers.resolved(),
      model: (await this.model()) ?? null,
      thinking: settings.thinking,
      timezone: settings.timezone,
    };
  }

  sharedCall(request: SharedRequest) {
    return serveShared(this.services().shared, request);
  }

  sharedStream(path: string) {
    return this.services().shared.readStream(path);
  }

  async report(agentId: AgentId, status: AgentStatus) {
    if (!this.live) return;
    if (await this.live.registry.setStatus(agentId, status))
      await this.events.emit({
        type: "agent.status",
        data: { agentId, status },
      });
  }

  async model() {
    const chosen = await this.services().settings.get("model");
    if (chosen) return chosen;
    if (this.host.test) return TEST_MODEL;
    const first = (await this.catalog.available())[0];
    return first ? { provider: first.provider, modelId: first.id } : undefined;
  }

  private async configChanged() {
    const { db } = this.host;
    const revision = Number((await getMeta(db, "revision")) ?? 1) + 1;
    await setMeta(db, "revision", String(revision));
    await this.catalog.rebuild(await this.services().providers.resolved());
    await Promise.allSettled(
      (await this.services().registry.list()).map((a) =>
        this.cell(a.id).configChanged(revision),
      ),
    );
  }

  async updateSettings(change: Partial<SettingsShape>) {
    const settings = await this.services().settings.update(change);
    await this.configChanged();
    await this.events.emit({ type: "settings.changed", data: {} });
    return settings;
  }

  async putProvider(config: ProviderConfig) {
    await this.services().providers.put(config);
    await this.configChanged();
    await this.events.emit({ type: "providers.changed", data: {} });
  }

  async removeProvider(id: string) {
    await this.services().providers.remove(id);
    await this.configChanged();
    await this.events.emit({ type: "providers.changed", data: {} });
  }

  async createAgent(input: NewAgent, by: string | null = null, key?: string) {
    this.requireActive();
    const profile = await this.services().registry.create(input, by, key);
    await this.cell(profile.id).provision(this.initOf(profile));
    await this.events.emit({ type: "agent.created", data: { agent: profile } });
    return profile;
  }

  async updateAgent(id: AgentId, change: ProfileChange) {
    this.requireActive();
    const profile = await this.services().registry.update(id, change);
    await this.cell(id)
      .profileChanged(profile)
      .catch(() => {});
    await this.events.emit({ type: "agent.changed", data: { agent: profile } });
    return profile;
  }

  async deleteAgent(id: AgentId) {
    this.requireActive();
    const { registry } = this.services();
    const profile = await registry.get(id);
    if (!profile) throw new RegistryError(`No agent ${id}`);
    if (profile.primary)
      throw new RegistryError("The primary agent cannot be deleted");
    const status = await this.cell(id).status();
    if (status?.working)
      throw new RegistryError(`${profile.name} is working; stop it first`);
    await registry.markDeleting(id);
    await this.cell(id).destroy();
    await registry.remove(id);
    await this.events.emit({ type: "agent.deleted", data: { agentId: id } });
  }

  async finishDeletes() {
    if (!this.live) return;
    for (const id of await this.live.registry.deleting()) {
      await this.cell(id).destroy();
      await this.live.registry.remove(id);
    }
  }

  private requireActive() {
    if (this.state_ !== "active")
      throw new StateError(this.state_, `The instance is ${this.state_}`);
  }

  private async agentIds() {
    return this.services().registry.ids();
  }

  async seal() {
    if (this.state_ !== "active")
      throw new StateError(
        this.state_,
        `Only an active instance can be sealed (it is ${this.state_})`,
      );
    await this.setState("sealed");
    for (const agent of await this.services().registry.list()) {
      await this.cell(agent.id).provision(this.initOf(agent));
      await this.cell(agent.id).seal();
    }
    await this.events.emit({ type: "instance.sealed", data: {} });
  }

  async unseal() {
    if (this.state_ !== "sealed")
      throw new StateError(this.state_, "The instance is not sealed");
    for (const id of await this.agentIds()) await this.cell(id).unseal();
    await this.setState("active");
    await this.events.emit({ type: "instance.unsealed", data: {} });
  }

  async markMoved() {
    if (this.state_ !== "sealed")
      throw new StateError(this.state_, "Seal and export the instance first");
    for (const id of await this.agentIds()) await this.cell(id).markMoved();
    await this.setState("moved");
  }

  async exportBundle(passphrase?: string) {
    if (this.state_ !== "sealed" && this.state_ !== "moved")
      throw new StateError(
        this.state_,
        "Seal the instance before exporting it",
      );
    const { db, blobs } = this.host;
    const live = this.services();
    const header: BundleHeader = {
      t: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      instanceId: this.activeInstanceId(),
      epoch: ((await this.epoch()) ?? 1) + 1,
      createdAt: this.now(),
      source: { host: this.host.name },
      ...(passphrase
        ? { dek: await wrapDek(live.secrets.rawDek(), passphrase) }
        : {}),
    };
    const ids = await this.agentIds();
    const cell = (id: AgentId) => this.cell(id);
    async function* records(): AsyncGenerator<BundleRecord> {
      yield header;
      yield { t: "part", kind: "coordinator" };
      yield* writePart(db, blobs, (table, columns, row) => {
        if (table !== "neo_meta") return true;
        return row[columns.indexOf("key")] !== "dek";
      });
      for (const id of ids) {
        yield { t: "part", kind: "agent", id };
        yield* decodeNdjson(await cell(id).exportPart());
      }
      yield { t: "end", parts: ids.length + 1 };
    }
    return encodeBundle(records());
  }

  async isNew() {
    if (this.state_ !== "active") return false;
    const live = this.services();
    if ((await live.providers.list()).length) return false;
    const agents = await live.registry.list();
    const [only, ...others] = agents;
    if (!only || others.length || !only.primary) return false;
    return this.cell(only.id).isNew();
  }

  async importBundle(body: ReadableStream<Uint8Array>, passphrase?: string) {
    const homecoming = this.state_ === "moved";
    if (!homecoming && !(await this.isNew()))
      throw new StateError(
        this.state_,
        "Import needs a new instance (this one has been used)",
      );
    const records = decodeBundle(body)[Symbol.asyncIterator]();
    const header = await readHeader(records);
    if (
      homecoming &&
      (header.instanceId !== this.instanceId_ ||
        header.epoch <= ((await this.epoch()) ?? 0))
    )
      throw new StateError(
        this.state_,
        "This host retired another instance (or a later copy of this one)",
      );
    if (header.dek && !passphrase)
      throw new BundleError("This bundle's secrets need its passphrase");
    const dek =
      header.dek && passphrase
        ? await unwrapDek(header.dek, passphrase)
        : undefined;
    const { db, blobs } = this.host;
    const instance = this.instance_;
    for (const id of await this.agentIds())
      await this.cell(id)
        .destroy()
        .catch(() => {});
    this.live = undefined;
    this.state_ = "empty";
    await wipeDatabase(db);
    await blobs.clear();
    await db.exec(`CREATE TABLE ${IMPORT_MARKER} (started_at INTEGER) STRICT`);
    const touched: AgentId[] = [];
    try {
      const first = await records.next();
      if (
        first.done ||
        first.value.t !== "part" ||
        first.value.kind !== "coordinator"
      )
        throw new BundleError("The bundle is damaged (no instance part)");
      await readPart(records, db, blobs);
      if ((await getMeta(db, "instance_id")) !== header.instanceId)
        throw new BundleError("The bundle's header and data disagree");
      this.instanceId_ = header.instanceId;
      this.instance_ = instance;
      if (instance) await setMeta(db, "instance", instance);
      const secrets = new Secrets(db, this.host.masterKey, this.now);
      if (dek) await secrets.storeDek(dek);
      else {
        await db.run(`DELETE FROM neo_meta WHERE key = 'dek'`);
        await db.run(`DELETE FROM neo_secrets`);
      }
      await this.start();
      const registry = this.services().registry;
      let parts = 1;
      for (;;) {
        const step = await records.next();
        if (step.done)
          throw new BundleError("The bundle is truncated (no end record)");
        const record = step.value;
        if (record.t === "end") {
          if (record.parts !== parts)
            throw new BundleError(
              `The bundle is damaged: ${parts} parts, expected ${record.parts}`,
            );
          break;
        }
        if (record.t !== "part" || record.kind !== "agent" || !record.id)
          throw new BundleError("The bundle is damaged (unexpected record)");
        const profile = await registry.get(record.id);
        if (!profile)
          throw new BundleError(
            `The bundle's agent ${record.id} is not listed`,
          );
        touched.push(record.id);
        await this.cell(record.id).importPart(
          this.initOf(profile),
          forwardPart(records),
        );
        parts++;
      }
      await setMeta(db, "epoch", String(header.epoch));
      await setMeta(db, "state", "active");
      await db.exec(`DROP TABLE ${IMPORT_MARKER}`);
    } catch (error) {
      for (const id of touched)
        await this.cell(id)
          .destroy()
          .catch(() => {});
      this.live = undefined;
      await wipeDatabase(db);
      await blobs.clear();
      this.instance_ = instance;
      await this.init();
      throw error;
    }
    this.state_ = "active";
    await this.events.emit({
      type: "instance.imported",
      data: {
        from: header.source.host,
        epoch: header.epoch,
      },
    });
    return {
      instanceId: this.activeInstanceId(),
      epoch: header.epoch,
      secrets: dek ? "kept" : "dropped",
    };
  }
}
