import { type HostPorts, masterKeyFromBase64, NeoHost } from "@neo/kernel";
import { createTestRuntime } from "@neo/kernel/testing";
import { CloudflareAlarm } from "./alarm";
import { CloudflareBlobs } from "./blobs";
import { CloudflareSqlite } from "./sqlite";

/**
 * A Neo instance in a Durable Object: its SQLite storage is the instance database, its alarm the
 * one timer, and R2 (under the object's own prefix) holds large file bytes.
 */
export class CloudflareHost extends NeoHost {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    super();
  }

  protected async ports(): Promise<HostPorts> {
    return {
      name: "cloudflare",
      db: new CloudflareSqlite(this.ctx.storage),
      blobs: new CloudflareBlobs(this.env.BLOBS, this.ctx.id.toString()),
      alarm: new CloudflareAlarm(this.ctx.storage),
      masterKey: await masterKeyFromBase64(this.env.NEO_MASTER_KEY),
      token: this.env.NEO_TOKEN,
      // A Durable Object hibernates between requests and runs no processes.
      capabilities: { sockets: false, processes: false },
      ...(this.env.NEO_TEST === "1" ? { test: createTestRuntime() } : {}),
    };
  }
}
