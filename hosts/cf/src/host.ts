import { type HostPorts, masterKeyFromBase64, NeoHost } from "@neo/kernel";
import { createTestRuntime } from "@neo/kernel/testing";
import { CloudflareAlarm } from "./alarm";
import { CloudflareBlobs } from "./blobs";
import { CloudflareSqlite } from "./sqlite";

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
      capabilities: { sockets: false, processes: false },
      ...(this.env.NEO_TEST === "1" ? { test: createTestRuntime() } : {}),
    };
  }
}
