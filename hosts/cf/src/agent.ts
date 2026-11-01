import { DurableObject } from "cloudflare:workers";
import { type AgentInit, RECOVERY_MS } from "@neo/kernel";
import type { AgentMessage, AgentProfile, AgentStatus } from "@neo/client";
import { CloudflareAgentHost } from "./host";

/** One agent: `<instance>/<agentId>`. Made only by its coordinator. */
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

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.host.fetch(request, {
      instance: request.headers.get("x-neo-instance")!,
      agentId: request.headers.get("x-neo-agent")!,
    });
  }

  override async alarm(): Promise<void> {
    await this.ready;
    await this.host.alarm();
  }

  async deliver(message: AgentMessage): Promise<void> {
    await (await this.agent()).deliver(message);
  }

  async interrupt(
    instance: string,
    agentId: string,
    from: string,
  ): Promise<{ stopped: boolean; cancelled: number }> {
    return (await this.agent()).interrupt({ instance, agentId }, from);
  }

  async provision(init: AgentInit): Promise<void> {
    await (await this.agent()).provision(init);
  }

  async profileChanged(profile: AgentProfile): Promise<void> {
    await (await this.agent()).profileChanged(profile);
  }

  async configChanged(revision: number): Promise<void> {
    await (await this.agent()).configChanged(revision);
  }

  async status(): Promise<AgentStatus | undefined> {
    return (await this.agent()).status();
  }

  async isNew(): Promise<boolean> {
    return (await this.agent()).isNew();
  }

  async seal(): Promise<void> {
    await (await this.agent()).seal();
  }

  async unseal(): Promise<void> {
    await (await this.agent()).unseal();
  }

  async markMoved(): Promise<void> {
    await (await this.agent()).markMoved();
  }

  async exportPart(): Promise<ReadableStream<Uint8Array>> {
    return (await this.agent()).exportPart();
  }

  async importPart(
    init: AgentInit,
    part: ReadableStream<Uint8Array>,
  ): Promise<void> {
    await (await this.agent()).importPart(init, part);
  }

  async destroy(): Promise<void> {
    await (await this.agent()).destroy();
  }
}
