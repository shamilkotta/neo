import { NeoClient } from "@neo/client";

// The suite runs against a Cloudflare host (`wrangler dev --var NEO_TEST:1`, or a deployed Worker):
// NEO_CF_URL. A Worker is one instance at `/i`; in test mode each test picks its own with the
// `x-neo-instance` header. `call` reaches the primary agent, `root` the instance.
export interface Instance {
  host: "cloudflare";
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  root<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  agent(id: string): { call<T = any>(method: string, path: string, body?: unknown): Promise<T> };
  /** The instance's API base (`…/i`). */
  url(): string;
  agentUrl(id?: string): string;
  /** Where the web app is served. */
  origin(): string;
  /** fetch with this test's instance header. */
  fetch: typeof fetch;
  client(): NeoClient;
  restart?: () => Promise<void>;
  close(): Promise<void>;
}

const CF = process.env.NEO_CF_URL;
export const TOKEN = "t";
export const PRIMARY = "neo";

export async function instance(): Promise<Instance> {
  if (!CF) throw new Error("Set NEO_CF_URL to run the suite (bun run test:cf)");
  const origin = CF.replace(/\/$/, "");
  const base = `${origin}/i`;
  const name = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const fetcher = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-neo-instance", name);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
  const client = () => new NeoClient({ url: base, token: TOKEN, fetch: fetcher });
  const root = client();
  const agent = (id: string) => {
    const one = root.agent(id);
    return {
      call: <T>(method: string, path: string, body?: unknown) =>
        one.call<T>(method, path, body),
    };
  };
  return {
    host: "cloudflare",
    call: agent(PRIMARY).call,
    root: (method, path, body) => root.call(method, path, body),
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

export const idle = (neo: Instance) =>
  until(
    async () => {
      const s = await neo.call("GET", "/status");
      return !s.turn && s.queued === 0 ? s : undefined;
    },
    8000,
    "idle",
  );

export const running = (neo: Instance) =>
  until(
    async () => (await neo.call("GET", "/status")).turn ?? undefined,
    5000,
    "a running turn",
  );

export const transcript = async (neo: Instance) =>
  (await neo.call("GET", "/transcript")).items as any[];
export const answers = async (neo: Instance) =>
  (await transcript(neo))
    .filter((i) => i.type === "assistant" && i.text)
    .map((i) => i.text as string);
