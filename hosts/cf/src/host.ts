import {
  type AgentPorts,
  AgentHost,
  type CoordinatorPorts,
  CoordinatorHost,
  masterKeyFromBase64,
} from "@neo/kernel";
import { createTestRuntime } from "@neo/kernel/testing";
import { CloudflareAlarm } from "./alarm";
import { CloudflareBlobs } from "./blobs";
import { agentCells, coordinatorLink } from "./links";
import { CloudflareSqlite } from "./sqlite";

const capabilities = { sockets: false, processes: false };

/** The coordinator of one instance (the instance Durable Object). */
export class CloudflareHost extends CoordinatorHost {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    super();
  }

  protected async ports(): Promise<CoordinatorPorts> {
    return {
      name: "cloudflare",
      db: new CloudflareSqlite(this.ctx.storage),
      blobs: new CloudflareBlobs(this.env.BLOBS, this.ctx.id.toString()),
      masterKey: await masterKeyFromBase64(this.env.NEO_MASTER_KEY),
      capabilities,
      cells: (instance) => agentCells(this.env, instance),
      ...(this.env.NEO_TEST === "1" ? { test: true } : {}),
    };
  }
}

/** One agent (an agent Durable Object). */
export class CloudflareAgentHost extends AgentHost {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    super();
  }

  protected async ports(): Promise<AgentPorts> {
    return {
      name: "cloudflare",
      db: new CloudflareSqlite(this.ctx.storage),
      blobs: new CloudflareBlobs(this.env.BLOBS, this.ctx.id.toString()),
      alarm: new CloudflareAlarm(this.ctx.storage),
      capabilities,
      coordinator: (instance) => coordinatorLink(this.env, instance),
      peers: (instance) => agentCells(this.env, instance),
      ...(this.env.NEO_TEST === "1" ? { test: createTestRuntime() } : {}),
    };
  }
}
