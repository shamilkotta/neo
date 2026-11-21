const COALESCE_MS = 25;

export class Changes<T extends string> {
  private readonly pending = new Set<T>();
  private readonly listeners = new Set<(topics: T[]) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  touch(...topics: T[]) {
    for (const topic of topics) this.pending.add(topic);
    this.timer ??= setTimeout(() => this.flush(), COALESCE_MS);
  }

  subscribe(listener: (topics: T[]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private flush() {
    this.timer = undefined;
    const topics = [...this.pending];
    this.pending.clear();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(topics);
      } catch {}
    }
  }
}
