import { NeoClient, type Status } from "@neo/client";
import { errorText } from "../lib/format";
import { createStore } from "../lib/store";

export class Instance {
  readonly root: NeoClient;
  readonly status = createStore<Status | undefined>(undefined);
  readonly error = createStore<string | undefined>(undefined);
  readonly settingsVersion = createStore(0);

  constructor(url: string, token: string) {
    this.root = new NeoClient({ url, token });
  }

  refresh = async () => {
    try {
      this.status.set(await this.root.status());
      this.error.set(undefined);
    } catch (e) {
      this.error.set(errorText(e));
    }
  };

  private timer: ReturnType<typeof setTimeout> | undefined;
  soon = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 80);
  };

  connect() {
    void this.refresh();
    return this.root.events({
      durable: (e) => {
        if (/^(agent|settings|providers|instance)\./.test(e.type))
          this.soon();
        if (/^(settings|providers)\./.test(e.type))
          this.settingsVersion.set((n) => n + 1);
      },
      error: () => this.soon(),
    });
  }
}
