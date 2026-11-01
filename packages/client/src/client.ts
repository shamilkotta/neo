import type {
  AgentProfile,
  AgentState,
  AgentSummary,
  AttachmentInput,
  NewAgent,
  ProfileChange,
  Upload,
  AvailableModel,
  ImportResult,
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
  url: string;
  token: string;
  fetch?: typeof fetch;
}

class Http {
  protected readonly base: string;
  protected readonly fetcher: typeof fetch;

  constructor(protected readonly options: NeoClientOptions) {
    this.base = options.url.replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
  }

  protected url(path: string): string {
    return this.base + path;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(this.url(path), {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      throw new NeoApiError(
        response.status,
        String(data.error ?? response.statusText),
        data,
      );
    return data as T;
  }

  protected async raw(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetcher(this.url(path), {
      method: "POST",
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(init.headers as Record<string, string>),
      },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      throw new NeoApiError(
        response.status,
        String(data.error ?? response.statusText),
        data,
      );
    }
    return response;
  }

  events(
    handlers: {
      durable?: (e: NeoEvent) => void;
      live?: (e: LiveEvent) => void;
      error?: (e: unknown) => void;
    },
    after = 0,
  ): () => void {
    let last = after;
    let stopped = false;
    let controller: AbortController | undefined;
    const run = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const response = await this.fetcher(
            this.url(`/events?after=${last}`),
            {
              headers: {
                authorization: `Bearer ${this.options.token}`,
                accept: "text/event-stream",
              },
              signal: controller.signal,
            },
          );
          if (!response.ok || !response.body)
            throw new NeoApiError(
              response.status,
              "The event stream failed",
              {},
            );
          for await (const frame of sseFrames(response.body)) {
            if (frame.event === "live")
              handlers.live?.(JSON.parse(frame.data) as LiveEvent);
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

/** The instance: agents, settings, providers, moves. */
export class NeoClient extends Http {
  /** One agent's API (chat, queue, schedules, files...). */
  agent(id: string): AgentClient {
    return new AgentClient({
      ...this.options,
      url: `${this.base}/agents/${encodeURIComponent(id)}`,
    });
  }

  status = () => this.call<Status>("GET", "/status");

  seal = () => this.call<{ state: string }>("POST", "/move/seal", {});
  unseal = () => this.call<{ state: string }>("POST", "/move/unseal", {});
  complete = () =>
    this.call<{ state: string }>("POST", "/move/complete", {});
  exportBundle = async (
    passphrase?: string,
  ): Promise<ReadableStream<Uint8Array>> => {
    const response = await this.raw("/move/export", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passphrase ? { passphrase } : {}),
    });
    return response.body!;
  };
  importBundle = async (
    bundle: BodyInit,
    passphrase?: string,
  ): Promise<ImportResult> => {
    const response = await this.raw("/move/import", {
      headers: {
        "content-type": "application/x-neo-bundle",
        ...(passphrase ? { "x-neo-passphrase": passphrase } : {}),
      },
      body: bundle,
      ...(bundle instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    return (await response.json()) as ImportResult;
  };

  agents = () =>
    this.call<{ agents: AgentSummary[] }>("GET", "/agents").then(
      (r) => r.agents,
    );
  createAgent = (input: NewAgent) =>
    this.call<{ agent: AgentProfile }>("POST", "/agents", input).then(
      (r) => r.agent,
    );
  updateAgent = (id: string, change: ProfileChange) =>
    this.call<{ agent: AgentProfile }>("PATCH", `/agents/${id}`, change).then(
      (r) => r.agent,
    );
  deleteAgent = (id: string) =>
    this.call<{ deleted: string }>("DELETE", `/agents/${id}`);

  settings = () =>
    this.call<{ settings: SettingsShape }>("GET", "/settings").then(
      (r) => r.settings,
    );
  updateSettings = (change: Partial<SettingsShape>) =>
    this.call<{ settings: SettingsShape }>("PUT", "/settings", change).then(
      (r) => r.settings,
    );
  providers = () =>
    this.call<{ providers: ProviderInfo[] }>("GET", "/providers").then(
      (r) => r.providers,
    );
  putProvider = (config: ProviderConfig) =>
    this.call<{ providers: ProviderInfo[] }>(
      "PUT",
      `/providers/${config.id}`,
      config,
    ).then((r) => r.providers);
  removeProvider = (id: string) =>
    this.call<{ providers: ProviderInfo[] }>(
      "DELETE",
      `/providers/${id}`,
    ).then((r) => r.providers);
  detectProviders = () =>
    this.call<{ found: ProviderConfig[] }>("GET", "/providers/detect").then(
      (r) => r.found,
    );
  models = () =>
    this.call<{ models: AvailableModel[]; default: ModelRef | null }>(
      "GET",
      "/models",
    );

}

/** One agent: its API lives under `<instance>/agents/<id>`. */
export class AgentClient extends Http {
  status = () => this.call<AgentState>("GET", "/status");
  profile = () =>
    this.call<{ agent: AgentState["agent"] }>("GET", "/agent").then(
      (r) => r.agent,
    );

  send = (
    text: string,
    options: { clientId?: string; attachments?: AttachmentInput[] } = {},
  ) =>
    this.call<{ message: MailboxMessage }>("POST", "/messages", {
      text,
      ...options,
    }).then((r) => r.message);
  upload = async (
    file: Blob,
    name: string,
  ): Promise<Upload & AttachmentInput> => {
    const { upload } = (await (
      await this.raw(`/uploads${query({ name })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      })
    ).json()) as { upload: Upload };
    return { ...upload, ...(file.type ? { mimeType: file.type } : {}) };
  };
  fileBlob = async (path: string): Promise<Blob> =>
    (
      await this.raw(`/attachments${query({ path })}`, { method: "GET" })
    ).blob();
  transcript = (options: { before?: number; limit?: number } = {}) =>
    this.call<TranscriptPage>("GET", `/transcript${query(options)}`);
  turn = (id: string) =>
    this.call<{ turn: Turn; messages: MailboxMessage[] }>(
      "GET",
      `/turns/${id}`,
    );
  stop = () => this.call<{ stopped: boolean }>("POST", "/stop");
  pause = () => this.call<{ paused: boolean }>("POST", "/pause");
  resume = () => this.call<{ paused: boolean }>("POST", "/resume");

  queue = () =>
    this.call<{ queue: MailboxMessage[] }>("GET", "/queue").then(
      (r) => r.queue,
    );
  editQueued = (id: string, text: string) =>
    this.call<{ message: MailboxMessage }>("PATCH", `/queue/${id}`, {
      text,
    });
  cancelQueued = (id: string) =>
    this.call<{ cancelled: string }>("DELETE", `/queue/${id}`);
  steerQueued = (id: string) =>
    this.call<{ steered: string }>("POST", `/queue/${id}/steer`);
  reorderQueue = (order: string[]) =>
    this.call<{ queue: MailboxMessage[] }>("PUT", "/queue/order", {
      order,
    }).then((r) => r.queue);

  schedules = () =>
    this.call<{ schedules: Schedule[] }>("GET", "/schedules").then(
      (r) => r.schedules,
    );
  toggleSchedule = (id: string, enabled: boolean) =>
    this.call<{ schedule: Schedule }>("PATCH", `/schedules/${id}`, {
      enabled,
    }).then((r) => r.schedule);

  async file(path: string): Promise<
    | {
        kind: "directory";
        path: string;
        entries: {
          path: string;
          name: string;
          kind: "file" | "directory";
          size: number;
          mtimeMs: number;
        }[];
      }
    | { kind: "file"; path: string; text: string }
  > {
    const response = await this.fetcher(
      this.url(`/files${query({ path })}`),
      {
        headers: { authorization: `Bearer ${this.options.token}` },
      },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      throw new NeoApiError(
        response.status,
        String(data.error ?? response.statusText),
        data,
      );
    }
    if ((response.headers.get("content-type") ?? "").includes("json"))
      return {
        kind: "directory",
        ...((await response.json()) as { path: string; entries: never[] }),
      };
    return { kind: "file", path, text: await response.text() };
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  return entries.length
    ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}`
    : "";
}

async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
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
