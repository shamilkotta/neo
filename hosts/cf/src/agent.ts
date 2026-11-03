import { DurableObject } from "cloudflare:workers";
import { type AgentInit, RECOVERY_MS } from "@neo/kernel";
import {
  type AgentId,
  type AgentMessage,
  type AgentProfile,
  isAgentId,
} from "@neo/client";
import { CloudflareAgentHost } from "./host";

export class AgentDO extends DurableObject<Env> {
  private readonly host: CloudflareAgentHost;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new CloudflareAgentHost(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const agent = await this.host.open();
      if (agent.state !== "active") return;
      const fallback = Date.now() + RECOVERY_MS;
      const current = await ctx.storage.getAlarm();
      if (current === null || current > fallback)
        await ctx.storage.setAlarm(fallback);
    });
  }

  private async agent() {
    await this.ready;
    return this.host.agent;
  }

  override async fetch(request: Request) {
    await this.ready;
    const instance = request.headers.get("x-neo-instance");
    const agentId = request.headers.get("x-neo-agent");
    if (!instance || !agentId || !isAgentId(agentId))
      return Response.json({ error: "No such agent" }, { status: 404 });
    return this.host.fetch(request, { instance, agentId });
  }

  override async alarm() {
    await this.ready;
    await this.host.alarm();
  }

  async deliver(message: AgentMessage) {
    await (await this.agent()).deliver(message);
  }

  async interrupt(instance: string, agentId: AgentId, from: AgentId) {
    return (await this.agent()).interrupt({ instance, agentId }, from);
  }

  async provision(init: AgentInit) {
    await (await this.agent()).provision(init);
  }

  async profileChanged(profile: AgentProfile) {
    await (await this.agent()).profileChanged(profile);
  }

  async configChanged(revision: number) {
    await (await this.agent()).configChanged(revision);
  }

  async status() {
    return (await this.agent()).status();
  }

  async isNew() {
    return (await this.agent()).isNew();
  }

  async seal() {
    await (await this.agent()).seal();
  }

  async unseal() {
    await (await this.agent()).unseal();
  }

  async markMoved() {
    await (await this.agent()).markMoved();
  }

  async exportPart() {
    return (await this.agent()).exportPart();
  }

  async importPart(init: AgentInit, part: ReadableStream<Uint8Array>) {
    await (await this.agent()).importPart(init, part);
  }

  async destroy() {
    await (await this.agent()).destroy();
  }
}
