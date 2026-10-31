import type { Alarm } from "@neo/kernel";

export class CloudflareAlarm implements Alarm {
  constructor(private readonly storage: DurableObjectStorage) {}

  async set(at: number | undefined): Promise<void> {
    if (at === undefined) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(at);
  }
}
