import type { Alarm } from "@neo/kernel";

/** setTimeout's longest delay; a later alarm rings early and the kernel sets it again. */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * The `alarm` port on Bun: one timer, like a Durable Object's alarm. It only rings; the kernel
 * decides when (`Neo.arm`) and what runs (`Neo.wake`).
 */
export class BunAlarm implements Alarm {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly ring: () => Promise<void>) {}

  set(at: number | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (at === undefined || this.closed) return;
    const delay = Math.min(Math.max(0, at - Date.now()), MAX_DELAY);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ring().catch(() => {});
    }, delay);
  }

  close(): void {
    this.closed = true;
    this.set(undefined);
  }
}
