import type { Alarm } from "@neo/kernel";

/**
 * The `alarm` port on Cloudflare: the Durable Object's alarm, which wakes the object even after it
 * was evicted. It only rings; the kernel decides when (`Neo.arm`) and what runs (`Neo.wake`).
 */
export class CloudflareAlarm implements Alarm {
  constructor(private readonly storage: DurableObjectStorage) {}

  async set(at: number | undefined): Promise<void> {
    if (at === undefined) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(at);
  }
}
