import type {
  AgentClient,
  AgentId,
  AgentState,
  MailboxMessage,
  NeoClient,
  NeoEvent,
  TranscriptItem,
  Turn,
} from "@neo/client";
import { errorText } from "../lib/format";
import { createStore } from "../lib/store";
import { applyLive, IDLE, type LiveTurn } from "./live";

export interface Thread {
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  older: number | null;
  loaded: boolean;
}

const EMPTY: Thread = { items: [], turns: {}, older: null, loaded: false };

export class AgentSession {
  readonly client: AgentClient;
  readonly state = createStore<AgentState | undefined>(undefined);
  readonly thread = createStore<Thread>(EMPTY);
  readonly queue = createStore<MailboxMessage[]>([]);
  readonly live = createStore<LiveTurn>(IDLE);
  readonly error = createStore<string | undefined>(undefined);
  readonly changed = createStore(0);
  private stop: (() => void) | null = null;
  private users = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(root: NeoClient, readonly id: AgentId) {
    this.client = root.agent(id);
  }

  attach() {
    this.users++;
    if (this.users === 1) void this.connect();
    return () => {
      this.users--;
      if (this.users === 0) {
        this.stop?.();
        this.stop = null;
      }
    };
  }

  private async connect() {
    const first = await this.client.status().catch((e) => {
      this.error.set(errorText(e));
      return undefined;
    });
    if (this.users === 0) return;
    await this.refresh();
    if (this.users === 0) return;
    this.stop = this.client.events(
      {
        durable: (e: NeoEvent) => {
          if (/^(turn|message|queue|agent)\./.test(e.type)) this.soon();
          if (/^(schedule|agent)\./.test(e.type))
            this.changed.set((n) => n + 1);
        },
        live: (e) =>
          this.live.set((current) => applyLive(current, e, () => this.soon())),
        error: () => this.soon(),
      },
      first?.latestEvent ?? 0,
    );
  }

  soon = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 60);
  };

  refresh = async () => {
    try {
      const [state, queue] = await Promise.all([
        this.client.status(),
        this.client.queue(),
      ]);
      this.state.set(state);
      this.queue.set(queue);
      if (!state.turn) this.live.set(IDLE);
      await this.load();
      this.error.set(undefined);
    } catch (e) {
      this.error.set(errorText(e));
    }
  };

  private async load(before?: number) {
    const page = await this.client.transcript({
      limit: 100,
      ...(before ? { before } : {}),
    });
    this.thread.set((current) => {
      const byId = new Map(current.items.map((i) => [i.entryId, i]));
      if (!before) {
        const min = page.items[0]?.entryId ?? Number.POSITIVE_INFINITY;
        for (const id of byId.keys()) if (id >= min) byId.delete(id);
      }
      for (const item of page.items) byId.set(item.entryId, item);
      return {
        items: [...byId.values()].sort((a, b) => a.entryId - b.entryId),
        turns: { ...current.turns, ...page.turns },
        older:
          before || !current.loaded || page.before === null
            ? page.before
            : current.older,
        loaded: true,
      };
    });
  }

  loadOlder = async () => {
    const older = this.thread.get().older;
    if (older) await this.load(older).catch((e) => this.error.set(errorText(e)));
  };
}

const sessions = new Map<string, AgentSession>();

export function session(root: NeoClient, id: AgentId) {
  let s = sessions.get(id);
  if (!s) {
    s = new AgentSession(root, id);
    sessions.set(id, s);
  }
  return s;
}

export const dropSession = (id: string) => sessions.delete(id);
