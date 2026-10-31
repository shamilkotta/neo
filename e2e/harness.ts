import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@neo/bun";
import { NeoClient } from "@neo/client";

/**
 * One fresh Neo instance per test, on the host under test:
 * - Bun (default): in process, in a temp folder; `restart()` closes and reopens it on its data.
 * - Cloudflare: `NEO_CF_URL=http://localhost:8799` (wrangler dev with NEO_TEST=1, NEO_TOKEN=t);
 *   each instance is a new Durable Object name.
 */
export interface Instance {
  host: "bun" | "cloudflare";
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** The instance's base URL. */
  url(): string;
  /** Bun only: stop the process's instance and open it again on the same data, as after a crash. */
  restart?: () => Promise<void>;
  close(): Promise<void>;
}

const CF = process.env.NEO_CF_URL;
const TOKEN = "t";

/** `on` picks the host; by default it is the host under test. */
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
      // Closing stops Pi without finishing the turn: what a crash leaves, minus a torn write.
      await running.stop();
      running = await serve({ dir, port: 0, test: true, token: TOKEN });
    },
    close: async () => {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Whether a Cloudflare host is under test (NEO_CF_URL). */
export const onCloudflare = !!CF;

/** Calls go through @neo/client, so the client every app uses is tested against every host. */
function client(base: () => string) {
  return <T>(method: string, path: string, body?: unknown): Promise<T> =>
    new NeoClient({ url: base(), token: TOKEN }).call<T>(method, path, body);
}

/** Polls until `check` returns a value (not undefined/false), or fails after `ms`. */
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

/** Waits until no turn runs and nothing is queued. */
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
