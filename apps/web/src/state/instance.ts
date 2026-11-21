import {
  type AgentId,
  type Connection,
  type InstanceTopic,
  NeoClient,
  type ServerSignal,
  type Status,
} from "@neo/client";
import { errorText } from "../lib/format";
import { puller } from "../lib/pull";
import { createStore } from "../lib/store";
import { AgentSession } from "./agent";

export class Instance {
  readonly root: NeoClient;
  readonly status = createStore<Status | undefined>(undefined);
  readonly error = createStore<string | undefined>(undefined);
  readonly settingsVersion = createStore(0);
  private readonly sessions = new Map<AgentId, AgentSession>();
  private connection: Connection | undefined;
  private watching: AgentId | null = null;

  constructor(url: string, token: string) {
    this.root = new NeoClient({ url, token });
  }

  refresh = puller(async () => {
    try {
      this.status.set(await this.root.status());
      this.error.set(undefined);
    } catch (e) {
      this.error.set(errorText(e));
    }
  });

  session(id: AgentId) {
    let session = this.sessions.get(id);
    if (!session) {
      session = new AgentSession(this.root, id);
      this.sessions.set(id, session);
    }
    return session;
  }

  watch(id: AgentId) {
    this.watching = id;
    this.connection?.watch(id);
    this.session(id).refresh();
    return () => {
      if (this.watching !== id) return;
      this.watching = null;
      this.connection?.watch(null);
    };
  }

  forget(id: AgentId) {
    this.sessions.delete(id);
  }

  connect() {
    void this.refresh();
    let reconnect = false;
    const connection = this.root.connect({
      open: () => {
        if (!reconnect) {
          reconnect = true;
          return;
        }
        void this.refresh();
        this.settingsVersion.set((n) => n + 1);
        if (this.watching) this.session(this.watching).refresh();
      },
      signal: (signal) => this.receive(signal),
    });
    this.connection = connection;
    if (this.watching) connection.watch(this.watching);
    return () => {
      connection.close();
      this.connection = undefined;
    };
  }

  private receive(signal: ServerSignal) {
    switch (signal.type) {
      case "changed":
        for (const topic of signal.topics) this.changed(topic);
        return;
      case "agent":
        this.sessions.get(signal.agentId)?.pull(signal.topics);
        return;
      case "live":
        this.sessions.get(signal.agentId)?.applyLive(signal.events);
        return;
      default: {
        const unhandled: never = signal;
        return unhandled;
      }
    }
  }

  private changed(topic: InstanceTopic) {
    switch (topic) {
      case "instance":
      case "agents":
        void this.refresh();
        return;
      case "settings":
      case "providers":
        this.settingsVersion.set((n) => n + 1);
        return;
      default: {
        const unhandled: never = topic;
        return unhandled;
      }
    }
  }
}
