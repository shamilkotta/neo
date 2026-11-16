import { Type, type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import {
  type AgentId,
  AgentProfile,
  AgentState,
  AgentView,
  AgentSummary,
  AvailableModel,
  ImportResult,
  JsonObject,
  MailboxMessage,
  type QuestionAnswer,
  ModelRef,
  ServerSignal,
  type ClientSignal,
  ProviderConfig,
  ProviderInfo,
  Schedule,
  SettingsShape,
  Status,
  TranscriptPage,
  Turn,
  Upload,
  parse,
  parseJson,
  type AttachmentInput,
  type NewAgent,
  type ProfileChange,
} from "./types";

export const SOCKET_PROTOCOL = "neo";
const TOKEN_PREFIX = "bearer.";

export const tokenProtocol = (token: string) =>
  TOKEN_PREFIX +
  btoa(String.fromCharCode(...new TextEncoder().encode(token)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function tokenFromProtocols(header: string | null) {
  const entry = header
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(TOKEN_PREFIX));
  if (!entry) return undefined;
  try {
    const base64 = entry
      .slice(TOKEN_PREFIX.length)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    return new TextDecoder().decode(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

export interface SignalHandlers {
  signal(signal: ServerSignal): void;
  open?(): void;
  close?(code: number): void;
}

export interface Connection {
  watch(agentId: AgentId | null): void;
  close(): void;
}

export class NeoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: JsonObject,
  ) {
    super(message);
  }
}

export interface NeoClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  socket?: (url: string, protocols: string[]) => WebSocket;
}

class Http {
  protected readonly base: string;
  protected readonly fetcher: typeof fetch;

  constructor(protected readonly options: NeoClientOptions) {
    this.base = options.url.replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
  }

  protected url(path: string) {
    return this.base + path;
  }

  async call<const S extends TSchema>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ) {
    const response = await this.fetcher(this.url(path), {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw await apiError(response);
    return parse(schema, await response.json());
  }

  protected async raw(path: string, init: RequestInit) {
    const response = await this.fetcher(this.url(path), {
      method: "POST",
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${this.options.token}`,
      },
    });
    if (!response.ok) throw await apiError(response);
    return response;
  }
}

export class NeoClient extends Http {
  agent(id: AgentId) {
    return new AgentClient({
      ...this.options,
      url: `${this.base}/agents/${encodeURIComponent(id)}`,
    });
  }

  status = () => this.call("GET", "/status", Status);

  connect(handlers: SignalHandlers): Connection {
    const socketUrl = this.url("/connect").replace(/^http/, "ws");
    let socket: WebSocket | undefined;
    let watching: AgentId | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (signal: ClientSignal) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(signal));
    };
    const open = () => {
      const protocols = [SOCKET_PROTOCOL, tokenProtocol(this.options.token)];
      const current = this.options.socket
        ? this.options.socket(socketUrl, protocols)
        : new WebSocket(socketUrl, protocols);
      socket = current;
      current.addEventListener("open", () => {
        retry = 0;
        if (watching) send({ type: "watch", agentId: watching });
        handlers.open?.();
      });
      current.addEventListener("message", (message: MessageEvent) => {
        if (typeof message.data !== "string") return;
        handlers.signal(parseJson(ServerSignal, message.data));
      });
      current.addEventListener("close", (event: CloseEvent) => {
        if (closed || socket !== current) return;
        handlers.close?.(event.code);
        timer = setTimeout(open, Math.min(30_000, 500 * 2 ** retry++));
      });
    };
    open();
    return {
      watch(agentId) {
        if (watching === agentId) return;
        watching = agentId;
        send({ type: "watch", agentId });
      },
      close() {
        closed = true;
        clearTimeout(timer);
        socket?.close();
      },
    };
  }

  seal = () =>
    this.call("POST", "/move/seal", Type.Object({ state: Type.String() }), {});
  unseal = () =>
    this.call(
      "POST",
      "/move/unseal",
      Type.Object({ state: Type.String() }),
      {},
    );
  complete = () =>
    this.call(
      "POST",
      "/move/complete",
      Type.Object({ state: Type.String() }),
      {},
    );
  exportBundle = async (passphrase?: string) => {
    const response = await this.raw("/move/export", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passphrase ? { passphrase } : {}),
    });
    if (!response.body) throw new NeoApiError(response.status, "No bundle", {});
    return response.body;
  };
  importBundle = async (bundle: BodyInit, passphrase?: string) => {
    const init: RequestInit & { duplex?: "half" } = {
      headers: {
        "content-type": "application/x-neo-bundle",
        ...(passphrase ? { "x-neo-passphrase": passphrase } : {}),
      },
      body: bundle,
      ...(bundle instanceof ReadableStream ? { duplex: "half" } : {}),
    };
    const response = await this.raw("/move/import", init);
    return parse(ImportResult, await response.json());
  };

  agents = () =>
    this.call(
      "GET",
      "/agents",
      Type.Object({ agents: Type.Array(AgentSummary) }),
    ).then((r) => r.agents);
  createAgent = (input: NewAgent) =>
    this.call(
      "POST",
      "/agents",
      Type.Object({ agent: AgentProfile }),
      input,
    ).then((r) => r.agent);
  updateAgent = (id: AgentId, change: ProfileChange) =>
    this.call(
      "PATCH",
      `/agents/${id}`,
      Type.Object({ agent: AgentProfile }),
      change,
    ).then((r) => r.agent);
  deleteAgent = (id: AgentId) =>
    this.call(
      "DELETE",
      `/agents/${id}`,
      Type.Object({ deleted: Type.String() }),
    );

  settings = () =>
    this.call(
      "GET",
      "/settings",
      Type.Object({ settings: SettingsShape }),
    ).then((r) => r.settings);
  updateSettings = (change: Partial<SettingsShape>) =>
    this.call(
      "PUT",
      "/settings",
      Type.Object({ settings: SettingsShape }),
      change,
    ).then((r) => r.settings);
  providers = () =>
    this.call(
      "GET",
      "/providers",
      Type.Object({ providers: Type.Array(ProviderInfo) }),
    ).then((r) => r.providers);
  putProvider = (config: ProviderConfig) =>
    this.call(
      "PUT",
      `/providers/${config.id}`,
      Type.Object({ providers: Type.Array(ProviderInfo) }),
      config,
    ).then((r) => r.providers);
  removeProvider = (id: string) =>
    this.call(
      "DELETE",
      `/providers/${id}`,
      Type.Object({ providers: Type.Array(ProviderInfo) }),
    ).then((r) => r.providers);
  detectProviders = () =>
    this.call(
      "GET",
      "/providers/detect",
      Type.Object({ found: Type.Array(ProviderConfig) }),
    ).then((r) => r.found);
  models = () =>
    this.call(
      "GET",
      "/models",
      Type.Object({
        models: Type.Array(AvailableModel),
        default: Type.Union([ModelRef, Type.Null()]),
      }),
    );
}

export class AgentClient extends Http {
  status = () => this.call("GET", "/status", AgentState);
  profile = () =>
    this.call("GET", "/agent", Type.Object({ agent: AgentView })).then(
      (r) => r.agent,
    );

  send = (
    text: string,
    options: { clientId?: string; attachments?: AttachmentInput[] } = {},
  ) =>
    this.call("POST", "/messages", Type.Object({ message: MailboxMessage }), {
      text,
      ...options,
    }).then((r) => r.message);
  answer = (answer: QuestionAnswer, options: { clientId?: string } = {}) =>
    this.call("POST", "/messages", Type.Object({ message: MailboxMessage }), {
      answer,
      ...options,
    }).then((r) => r.message);
  upload = async (file: Blob, name: string) => {
    const { upload } = parse(
      Type.Object({ upload: Upload }),
      await (
        await this.raw(`/uploads${query({ name })}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        })
      ).json(),
    );
    return { ...upload, ...(file.type ? { mimeType: file.type } : {}) };
  };
  fileBlob = async (path: string) =>
    (
      await this.raw(`/attachments${query({ path })}`, { method: "GET" })
    ).blob();
  transcript = (
    options: { before?: number; from?: number; limit?: number } = {},
  ) =>
    this.call("GET", `/transcript${query(options)}`, TranscriptPage);
  turn = (id: string) =>
    this.call(
      "GET",
      `/turns/${id}`,
      Type.Object({ turn: Turn, messages: Type.Array(MailboxMessage) }),
    );
  stop = () =>
    this.call("POST", "/stop", Type.Object({ stopped: Type.Boolean() }));
  pause = () =>
    this.call("POST", "/pause", Type.Object({ paused: Type.Boolean() }));
  resume = () =>
    this.call("POST", "/resume", Type.Object({ paused: Type.Boolean() }));

  queue = () =>
    this.call(
      "GET",
      "/queue",
      Type.Object({ queue: Type.Array(MailboxMessage) }),
    ).then((r) => r.queue);
  editQueued = (id: string, text: string) =>
    this.call(
      "PATCH",
      `/queue/${id}`,
      Type.Object({ message: MailboxMessage }),
      {
        text,
      },
    );
  cancelQueued = (id: string) =>
    this.call(
      "DELETE",
      `/queue/${id}`,
      Type.Object({ cancelled: Type.String() }),
    );
  steerQueued = (id: string) =>
    this.call(
      "POST",
      `/queue/${id}/steer`,
      Type.Object({ steered: Type.String() }),
    );
  reorderQueue = (order: string[]) =>
    this.call(
      "PUT",
      "/queue/order",
      Type.Object({ queue: Type.Array(MailboxMessage) }),
      {
        order,
      },
    ).then((r) => r.queue);

  schedules = () =>
    this.call(
      "GET",
      "/schedules",
      Type.Object({ schedules: Type.Array(Schedule) }),
    ).then((r) => r.schedules);
  toggleSchedule = (id: string, enabled: boolean) =>
    this.call(
      "PATCH",
      `/schedules/${id}`,
      Type.Object({ schedule: Schedule }),
      {
        enabled,
      },
    ).then((r) => r.schedule);

  async file(
    path: string,
  ): Promise<
    | ({ kind: "directory" } & Static<typeof Directory>)
    | { kind: "file"; path: string; text: string }
  > {
    const response = await this.fetcher(this.url(`/files${query({ path })}`), {
      headers: { authorization: `Bearer ${this.options.token}` },
    });
    if (!response.ok) throw await apiError(response);
    if ((response.headers.get("content-type") ?? "").includes("json"))
      return {
        kind: "directory",
        ...parse(Directory, await response.json()),
      };
    return { kind: "file", path, text: await response.text() };
  }
}

const Directory = Type.Object({
  path: Type.String(),
  entries: Type.Array(
    Type.Object({
      path: Type.String(),
      name: Type.String(),
      kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
      size: Type.Number(),
      mtimeMs: Type.Number(),
    }),
  ),
});

const ErrorBody = Type.Object({ error: Type.Optional(Type.String()) });

async function apiError(response: Response) {
  const data: unknown = await response.json().catch(() => ({}));
  const body = Value.Check(JsonObject, data) ? data : {};
  const message = Value.Check(ErrorBody, body) ? body.error : undefined;
  return new NeoApiError(response.status, message ?? response.statusText, body);
}

function query(params: Record<string, string | number | undefined>) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  return entries.length
    ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}`
    : "";
}
