import { DurableObject } from "cloudflare:workers";
import type {
  AgentConfig,
  AgentInit,
  SharedOp,
  SharedResult,
} from "@neo/kernel";
import type {
  AgentProfile,
  AgentStatus,
  AgentSummary,
  NewAgent,
  ProfileChange,
} from "@neo/client";
import { CloudflareHost } from "./host";

/** The coordinator of one instance: `/i/<name>`. */
export class InstanceDO extends DurableObject<Env> {
  private readonly host: CloudflareHost;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new CloudflareHost(ctx, env);
    // Only its own storage here: an agent may be waiting on this DO, so no calls out.
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.host.open();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.host.fetch(request, request.headers.get("x-neo-instance")!);
  }

  async agentInit(
    instance: string,
    agentId: string,
  ): Promise<AgentInit | undefined> {
    await this.ready;
    return (await this.host.named(instance)).agentInit(agentId);
  }

  async agentConfig(instance: string): Promise<AgentConfig> {
    await this.ready;
    return (await this.host.named(instance)).agentConfig();
  }

  async agentReport(
    instance: string,
    agentId: string,
    status: AgentStatus,
  ): Promise<void> {
    await this.ready;
    await (await this.host.named(instance)).report(agentId, status);
  }

  async agentList(instance: string): Promise<AgentSummary[]> {
    await this.ready;
    return (await this.host.named(instance)).services().registry.list();
  }

  async agentCreate(
    instance: string,
    by: string,
    input: NewAgent,
    key: string,
  ): Promise<AgentProfile> {
    await this.ready;
    return (await this.host.named(instance)).createAgent(input, by, key);
  }

  async agentUpdate(
    instance: string,
    agentId: string,
    change: ProfileChange,
  ): Promise<AgentProfile> {
    await this.ready;
    return (await this.host.named(instance)).updateAgent(agentId, change);
  }

  async sharedCall(
    instance: string,
    op: SharedOp,
    args: unknown[],
  ): Promise<SharedResult> {
    await this.ready;
    return (await this.host.named(instance)).sharedCall(op, args);
  }

  async sharedStream(
    instance: string,
    path: string,
  ): Promise<ReadableStream<Uint8Array>> {
    await this.ready;
    return (await this.host.named(instance)).sharedStream(path);
  }
}
