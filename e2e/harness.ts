import {
  AgentState,
  MailboxMessage,
  Memory,
  NeoApiError,
  NeoClient,
  Schedule,
  TranscriptPage,
  Turn,
  type TranscriptItem,
  agentId,
} from "@neo/client";
import { Type, type Static, type TSchema } from "typebox";

export interface Caller {
  call<const S extends TSchema>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<Static<S>>;
  act(method: string, path: string, body?: unknown): Promise<void>;
}

export interface Instance extends Caller {
  host: "cloudflare";
  root: Caller;
  agent(id: string): Caller;
  url(): string;
  agentUrl(id?: string): string;
  origin(): string;
  fetch: typeof fetch;
  client(): NeoClient;
  restart?: () => Promise<void>;
  close(): Promise<void>;
}

export const Seen = Type.Object({ seen: Type.Array(Type.String()) });
export const Queued = Type.Object({ message: MailboxMessage });
export const Queue = Type.Object({ queue: Type.Array(MailboxMessage) });
export const OneSchedule = Type.Object({ schedule: Schedule });
export const Schedules = Type.Object({ schedules: Type.Array(Schedule) });
export const Runs = Type.Object({
  runs: Type.Array(
    Type.Object({
      status: Type.String(),
      reason: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});
export const Memories = Type.Object({ memories: Type.Array(Memory) });
export const Pending = Type.Object({ pending: Type.Number() });
export const TurnDetail = Type.Object({
  turn: Turn,
  messages: Type.Array(MailboxMessage),
});
export const Stopped = Type.Object({ stopped: Type.Boolean() });
export const Upload = Type.Object({
  upload: Type.Object({
    id: Type.String(),
    name: Type.String(),
    size: Type.Number(),
  }),
});
export { AgentState, TranscriptPage };

const CF = process.env.NEO_CF_URL;
export const TOKEN = "t";
export const PRIMARY = "neo";

function caller(client: NeoClient | ReturnType<NeoClient["agent"]>): Caller {
  return {
    call: (method, path, schema, body) =>
      client.call(method, path, schema, body),
    act: async (method, path, body) => {
      await client.call(method, path, Type.Unknown(), body);
    },
  };
}

export async function instance(): Promise<Instance> {
  if (!CF) throw new Error("Set NEO_CF_URL to run the suite (bun run test:cf)");
  const origin = CF.replace(/\/$/, "");
  const base = `${origin}/i`;
  const name = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const fetcher: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("x-neo-instance", name);
      return fetch(input, { ...init, headers });
    },
    { preconnect: fetch.preconnect },
  );
  const client = () =>
    new NeoClient({ url: base, token: TOKEN, fetch: fetcher });
  const root = client();
  const agent = (id: string) => caller(root.agent(agentId(id)));
  return {
    host: "cloudflare",
    ...agent(PRIMARY),
    root: caller(root),
    agent,
    url: () => base,
    agentUrl: (id = PRIMARY) => `${base}/agents/${id}`,
    origin: () => origin,
    fetch: fetcher,
    client,
    close: async () => {},
  };
}

export const onCloudflare = true;

export async function until<T>(
  check: () => Promise<T | undefined | false>,
  ms = 5000,
  what = "condition",
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

export const idle = (neo: Caller) =>
  until(
    async () => {
      const s = await neo.call("GET", "/status", AgentState);
      return !s.turn && s.queued === 0 ? s : undefined;
    },
    8000,
    "idle",
  );

export const running = (neo: Caller) =>
  until(
    async () =>
      (await neo.call("GET", "/status", AgentState)).turn ?? undefined,
    5000,
    "a running turn",
  );

export const transcript = async (neo: Caller): Promise<TranscriptItem[]> =>
  (await neo.call("GET", "/transcript", TranscriptPage)).items;

export const answers = async (neo: Caller) =>
  (await transcript(neo)).flatMap((i) =>
    i.type === "assistant" && i.text ? [i.text] : [],
  );

export type ItemOf<K extends TranscriptItem["type"]> = Extract<
  TranscriptItem,
  { type: K }
>;

export function isItem<K extends TranscriptItem["type"]>(
  item: TranscriptItem,
  type: K,
): item is ItemOf<K> {
  return item.type === type;
}

export function itemAs<K extends TranscriptItem["type"]>(
  item: TranscriptItem | undefined,
  type: K,
): ItemOf<K> {
  if (!item || !isItem(item, type))
    throw new Error(`Expected a ${type} item, got ${item?.type ?? "nothing"}`);
  return item;
}

export const itemsOf = async <K extends TranscriptItem["type"]>(
  neo: Caller,
  type: K,
): Promise<ItemOf<K>[]> =>
  (await transcript(neo)).filter((i): i is ItemOf<K> => isItem(i, type));

export const inputs = async (neo: Caller) =>
  (await transcript(neo)).flatMap((i) =>
    i.type === "input" ? i.messages : [],
  );

export const toolResults = (neo: Caller) => itemsOf(neo, "tool");

export const seen = async (neo: Caller) =>
  (await neo.call("GET", "/test/seen", Seen)).seen;

export async function failure(work: Promise<unknown>): Promise<NeoApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof NeoApiError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail");
}
