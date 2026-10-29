import { DurableObject } from "cloudflare:workers";
import { RECOVERY_MS } from "@neo/kernel";
import { CloudflareHost } from "./host";

/** One Neo instance per Durable Object. */
export class InstanceDO extends DurableObject<Env> {
  private readonly host: CloudflareHost;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new CloudflareHost(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      // A fallback alarm before anything can throw, so a failed start is tried again.
      const fallback = Date.now() + RECOVERY_MS;
      const current = await ctx.storage.getAlarm();
      if (current === null || current > fallback)
        await ctx.storage.setAlarm(fallback);
      // Opening resumes interrupted work and sets the alarm to what the instance needs.
      await this.host.open();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.host.fetch(request);
  }

  override async alarm(): Promise<void> {
    await this.ready;
    await this.host.alarm();
  }
}
