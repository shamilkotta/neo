import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@neo/bun";
import { NeoClient } from "@neo/client";

export interface Instance {
  host: "bun" | "cloudflare";
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  url(): string;
  restart?: () => Promise<void>;
  close(): Promise<void>;
}

const CF = process.env.NEO_CF_URL;
const TOKEN = "t";

export async function instance(
  on: "bun" | "cloudflare" = CF ? "cloudflare" : "bun",
): Promise<Instance> {
  if (on === "cloudflare") {
    if (!CF) throw new Error("Set NEO_CF_URL to test on Cloudflare");
    const base = `${CF.replace(/\/$/, "")}/i/e2e-${crypto.randomUUID().slice(0, 8)}`;
    return {
      host: "cloudflare",
      call: client(() => base),
      url: () => base,
      close: async () => {},
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "neo-e2e-"));
  let running = await serve({ dir, port: 0, test: true, token: TOKEN });
  return {
    host: "bun",
    call: client(() => running.url),
    url: () => running.url,
    restart: async () => {
      await running.stop();
      running = await serve({ dir, port: 0, test: true, token: TOKEN });
    },
    close: async () => {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const onCloudflare = !!CF;

function client(base: () => string) {
  return <T>(method: string, path: string, body?: unknown): Promise<T> =>
    new NeoClient({ url: base(), token: TOKEN }).call<T>(method, path, body);
}

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
      const s = await neo.call("GET", "/v1/status");
      return !s.turn && s.queued === 0 ? s : undefined;
    },
    8000,
    "idle",
  );

export const running = (neo: Instance) =>
  until(
    async () => (await neo.call("GET", "/v1/status")).turn ?? undefined,
    5000,
    "a running turn",
  );

export const transcript = async (neo: Instance) =>
  (await neo.call("GET", "/v1/transcript")).items as any[];
export const answers = async (neo: Instance) =>
  (await transcript(neo))
    .filter((i) => i.type === "assistant" && i.text)
    .map((i) => i.text as string);
