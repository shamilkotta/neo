import type {
  AgentChange,
  AgentRecord,
  AvailableModel,
  LiveEvent,
  MailboxMessage,
  ModelRef,
  NeoEvent,
  ProviderConfig,
  ProviderInfo,
  SettingsShape,
  Status,
  TranscriptPage,
  Turn,
  Schedule,
  ScheduleRun,
} from "./types";

export class NeoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface NeoClientOptions {
  /** The instance's base URL: `http://127.0.0.1:7420` or `https://<worker>/i/<name>`. */
  url: string;
  token: string;
  fetch?: typeof fetch;
}

/**
 * A typed client for one Neo instance, for every app (web, desktop, mobile, CLI) and the tests.
 * Runs anywhere `fetch` does.
 */
export class NeoClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: NeoClientOptions) {
    this.base = options.url.replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw new NeoApiError(response.status, String(data.error ?? response.statusText), data);
    return data as T;
  }

  status = () => this.call<Status>("GET", "/v1/status");

  // ---- conversation ----
  send = (text: string, options: { clientId?: string } = {}) =>
    this.call<{ message: MailboxMessage }>("POST", "/v1/messages", { text, ...options }).then((r) => r.message);
  transcript = (options: { before?: number; limit?: number } = {}) =>
    this.call<TranscriptPage>("GET", `/v1/transcript${query(options)}`);
  turn = (id: string) => this.call<{ turn: Turn; messages: MailboxMessage[] }>("GET", `/v1/turns/${id}`);
  stop = () => this.call<{ stopped: boolean }>("POST", "/v1/stop");
  pause = () => this.call<{ paused: boolean }>("POST", "/v1/pause");
  resume = () => this.call<{ paused: boolean }>("POST", "/v1/resume");

  // ---- queue ----
  queue = () => this.call<{ queue: MailboxMessage[] }>("GET", "/v1/queue").then((r) => r.queue);
  editQueued = (id: string, text: string) => this.call<{ message: MailboxMessage }>("PATCH", `/v1/queue/${id}`, { text });
  cancelQueued = (id: string) => this.call<{ cancelled: string }>("DELETE", `/v1/queue/${id}`);
  steerQueued = (id: string) => this.call<{ steered: string }>("POST", `/v1/queue/${id}/steer`);
  reorderQueue = (order: string[]) =>
    this.call<{ queue: MailboxMessage[] }>("PUT", "/v1/queue/order", { order }).then((r) => r.queue);

  // ---- schedules ----
  schedules = () => this.call<{ schedules: Schedule[] }>("GET", "/v1/schedules").then((r) => r.schedules);
  toggleSchedule = (id: string, enabled: boolean) =>
    this.call<{ schedule: Schedule }>("PATCH", `/v1/schedules/${id}`, { enabled }).then((r) => r.schedule);
  scheduleRuns = (id: string) =>
    this.call<{ runs: ScheduleRun[] }>("GET", `/v1/schedules/${id}/runs`).then((r) => r.runs);

  // ---- agent, settings, models ----
  agent = () => this.call<{ agent: AgentRecord }>("GET", "/v1/agent").then((r) => r.agent);
  updateAgent = (change: AgentChange) =>
    this.call<{ agent: AgentRecord }>("PATCH", "/v1/agent", change).then((r) => r.agent);
  settings = () => this.call<{ settings: SettingsShape }>("GET", "/v1/settings").then((r) => r.settings);
  updateSettings = (change: Partial<SettingsShape>) =>
    this.call<{ settings: SettingsShape }>("PUT", "/v1/settings", change).then((r) => r.settings);
  providers = () => this.call<{ providers: ProviderInfo[] }>("GET", "/v1/providers").then((r) => r.providers);
  putProvider = (config: ProviderConfig) =>
    this.call<{ providers: ProviderInfo[] }>("PUT", `/v1/providers/${config.id}`, config).then((r) => r.providers);
  removeProvider = (id: string) =>
    this.call<{ providers: ProviderInfo[] }>("DELETE", `/v1/providers/${id}`).then((r) => r.providers);
  detectProviders = () => this.call<{ found: ProviderConfig[] }>("GET", "/v1/providers/detect").then((r) => r.found);
  models = () => this.call<{ models: AvailableModel[]; default: ModelRef | null }>("GET", "/v1/models");

  // ---- files ----
  /** A directory listing, or a file's text. */
  async file(
    path: string,
  ): Promise<
    | { kind: "directory"; path: string; entries: { path: string; name: string; kind: "file" | "directory"; size: number; mtimeMs: number }[] }
    | { kind: "file"; path: string; text: string }
  > {
    const response = await this.fetcher(`${this.base}/v1/files${query({ path })}`, {
      headers: { authorization: `Bearer ${this.options.token}` },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new NeoApiError(response.status, String(data.error ?? response.statusText), data);
    }
    if ((response.headers.get("content-type") ?? "").includes("json"))
      return { kind: "directory", ...((await response.json()) as { path: string; entries: never[] }) };
    return { kind: "file", path, text: await response.text() };
  }
  writeFile = (path: string, text: string) =>
    this.fetcher(`${this.base}/v1/files${query({ path })}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.options.token}` },
      body: text,
    }).then((r) => {
      if (!r.ok) throw new NeoApiError(r.status, "Write failed", {});
    });

  /**
   * Follows the event stream: durable events after `after` (then as they happen) and live turn
   * events. Reconnects on its own, resuming after the last durable event. Returns a stop function.
   */
  events(
    handlers: { durable?: (e: NeoEvent) => void; live?: (e: LiveEvent) => void; error?: (e: unknown) => void },
    after = 0,
  ): () => void {
    let last = after;
    let stopped = false;
    let controller: AbortController | undefined;
    const run = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const response = await this.fetcher(`${this.base}/v1/events?after=${last}`, {
            headers: { authorization: `Bearer ${this.options.token}`, accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new NeoApiError(response.status, "The event stream failed", {});
          for await (const frame of sseFrames(response.body)) {
            if (frame.event === "live") handlers.live?.(JSON.parse(frame.data) as LiveEvent);
            else if (frame.data) {
              const event = JSON.parse(frame.data) as NeoEvent;
              last = Math.max(last, event.seq);
              handlers.durable?.(event);
            }
          }
        } catch (error) {
          if (stopped) return;
          handlers.error?.(error);
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void run();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : "";
}

/** Parses a server-sent event stream into frames; comments (pings) are skipped. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}
