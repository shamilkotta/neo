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

export class InstanceDO extends DurableObject<Env> {
  private readonly host: CloudflareHost;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new CloudflareHost(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.host.open();
    });
  }

  override async fetch(request: Request) {
    await this.ready;
    return this.host.fetch(request, request.headers.get("x-neo-instance")!);
  }

  async agentInit(instance: string, agentId: string) {
    await this.ready;
    return (await this.host.named(instance)).agentInit(agentId);
  }

  async agentConfig(instance: string) {
    await this.ready;
    return (await this.host.named(instance)).agentConfig();
  }

  async agentReport(instance: string, agentId: string, status: AgentStatus) {
    await this.ready;
    await (await this.host.named(instance)).report(agentId, status);
  }

  async agentList(instance: string) {
    await this.ready;
    return (await this.host.named(instance)).services().registry.list();
  }

  async agentCreate(
    instance: string,
    by: string,
    input: NewAgent,
    key: string,
  ) {
    await this.ready;
    return (await this.host.named(instance)).createAgent(input, by, key);
  }

  async agentUpdate(instance: string, agentId: string, change: ProfileChange) {
    await this.ready;
    return (await this.host.named(instance)).updateAgent(agentId, change);
  }

  async sharedCall(instance: string, op: SharedOp, args: unknown[]) {
    await this.ready;
    return (await this.host.named(instance)).sharedCall(op, args);
  }

  async sharedStream(instance: string, path: string) {
    await this.ready;
    return (await this.host.named(instance)).sharedStream(path);
  }
}
