import type {
  AgentClient,
  AgentId,
  AgentState,
  AgentTopic,
  MailboxMessage,
  NeoClient,
  TranscriptItem,
  TranscriptPage,
  Turn,
} from "@neo/client";
import { errorText } from "../lib/format";
import { puller } from "../lib/pull";
import { createStore } from "../lib/store";
import { applyLive, IDLE, type LiveTurn } from "./live";

export interface Thread {
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  older: number | null;
  loaded: boolean;
}

export interface Pending {
  key: string;
  text: string;
  files: string[];
  at: number;
  id?: string;
}

const EMPTY: Thread = { items: [], turns: {}, older: null, loaded: false };
const PAGE = 100;

export class AgentSession {
  readonly client: AgentClient;
  readonly state = createStore<AgentState | undefined>(undefined);
  readonly thread = createStore<Thread>(EMPTY);
  readonly queue = createStore<MailboxMessage[]>([]);
  readonly live = createStore<LiveTurn>(IDLE);
  readonly pending = createStore<Pending[]>([]);
  readonly error = createStore<string | undefined>(undefined);
  readonly schedulesVersion = createStore(0);

  constructor(root: NeoClient, readonly id: AgentId) {
    this.client = root.agent(id);
  }

  private readonly pullStatus = puller(() =>
    this.guard(async () => {
      const state = await this.client.status();
      this.state.set(state);
      if (!state.turn) this.live.set(IDLE);
      else if (!this.live.get().active) this.live.set((current) => ({ ...current, active: true }));
      this.settlePending();
    }),
  );

  private readonly pullQueue = puller(() =>
    this.guard(async () => {
      this.queue.set(await this.client.queue());
      this.settlePending();
    }),
  );

  private readonly pullTranscript = puller(() =>
    this.guard(async () => {
      const current = this.thread.get();
      if (!current.loaded) {
        const page = await this.client.transcript({ limit: PAGE });
        this.thread.set({ ...page, older: page.before, loaded: true });
      } else {
        const from = openFrom(current);
        this.thread.set(mergeTail(this.thread.get(), from, await this.client.transcript({ from, limit: PAGE })));
      }
      this.settlePending();
    }),
  );

  pull(topics: readonly AgentTopic[]) {
    for (const topic of topics) {
      switch (topic) {
        case "status":
        case "profile":
          void this.pullStatus();
          break;
        case "queue":
          void this.pullQueue();
          break;
        case "transcript":
          void this.pullTranscript();
          break;
        case "schedules":
          this.schedulesVersion.set((n) => n + 1);
          break;
        case "memory":
          break;
        default: {
          const unhandled: never = topic;
          return unhandled;
        }
      }
    }
  }

  refresh = () => {
    this.pull(["status", "queue", "transcript", "schedules"]);
  };

  applyLive(events: unknown[]) {
    this.live.set((current) => events.reduce<LiveTurn>(applyLive, current));
  }

  loadOlder = async () => {
    const before = this.thread.get().older;
    if (!before) return;
    await this.guard(async () => {
      const page = await this.client.transcript({ before, limit: PAGE });
      this.thread.set((current) => ({
        items: [...page.items, ...current.items.filter((i) => i.entryId >= before)],
        turns: { ...page.turns, ...current.turns },
        older: page.before,
        loaded: true,
      }));
    });
  };

  send = async (text: string, files: File[]) => {
    const key = `web-${crypto.randomUUID()}`;
    const running = !!this.state.get()?.turn;
    if (!running)
      this.pending.set((all) => [...all, { key, text, files: files.map((f) => f.name || "file"), at: Date.now() }]);
    try {
      const attachments = [];
      for (const file of files) attachments.push(await this.client.upload(file, file.name || "file"));
      const message = await this.client.send(text, {
        clientId: key,
        ...(attachments.length ? { attachments } : {}),
      });
      this.pending.set((all) => all.map((p) => (p.key === key ? { ...p, id: message.id } : p)));
      this.settlePending();
      return { queued: running };
    } catch (e) {
      this.pending.set((all) => all.filter((p) => p.key !== key));
      throw e;
    }
  };

  private async guard(run: () => Promise<void>) {
    try {
      await run();
      this.error.set(undefined);
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  private settlePending() {
    const state = this.state.get();
    if (!state) return;
    const shown = new Set(
      this.thread.get().items.flatMap((i) => (i.type === "input" ? i.messages.map((m) => m.id) : [])),
    );
    const paused = state.state === "active" && state.agent.paused;
    const waiting = new Set(paused ? [] : this.queue.get().map((m) => m.id));
    this.pending.set((all) => {
      const left = all.filter((p) => !p.id || (!shown.has(p.id) && (waiting.has(p.id) || !!state.turn)));
      return left.length === all.length ? all : left;
    });
  }
}

function openFrom(thread: Thread) {
  const last = thread.items.at(-1);
  if (!last) return 0;
  const open = thread.items.find((i) => i.type === "input" && thread.turns[i.turnId]?.status === "running");
  return open ? open.entryId : last.entryId + 1;
}

function mergeTail(current: Thread, from: number, page: TranscriptPage): Thread {
  if (page.before !== null)
    return { items: page.items, turns: page.turns, older: page.before, loaded: true };
  return {
    items: [...current.items.filter((i) => i.entryId < from), ...page.items],
    turns: { ...current.turns, ...page.turns },
    older: current.older,
    loaded: true,
  };
}
