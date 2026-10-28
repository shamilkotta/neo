import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { type AgentChange, DEFAULT_AGENT_ID } from "./agent/agents";
import { MailboxError } from "./agent/mailbox";
import { readTranscript } from "./agent/transcript";
import { WakeupError, wakeupTime } from "./agent/wakeups";
import { timingSafeEqual } from "./crypto";
import { type Neo, NEO_VERSION, SetupError, StateError } from "./neo";
import { MemoryError, type MemoryKind } from "./services/memory";
import { detectLocalProviders, type ProviderConfig } from "./services/providers";
import type { SettingsShape } from "./services/settings";
import { VfsError } from "./vfs/vfs";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Any origin may call the API: it is authorized by a bearer token in a header, never a cookie, so
 * a page cannot use the person's session without the token. This is what lets a standalone web
 * app (or desktop and mobile apps) talk to any instance.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, last-event-id",
  "access-control-max-age": "86400",
};

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "The body is not JSON");
  }
}

/**
 * Neo's HTTP API, the same on every host: `/v1/...`, JSON, `Authorization: Bearer <token>`. The
 * kernel serves only the API; hosts serve the web app's files next to it.
 */
export async function handleApi(neo: Neo, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return withCors(await respond(neo, request));
}

async function respond(neo: Neo, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (!path.startsWith("/v1/")) throw new HttpError(404, "Not found");
    const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!given || !timingSafeEqual(given, neo.host.token)) throw new HttpError(401, "Unauthorized");
    return await route(neo, request, url);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof StateError) return json({ error: error.message, state: error.state }, 409);
    if (error instanceof SetupError) return json({ error: error.message, setup: true }, 409);
    if (error instanceof MailboxError || error instanceof WakeupError || error instanceof MemoryError)
      return json({ error: error.message }, 400);
    if (error instanceof VfsError)
      return json({ error: error.message, code: error.code }, error.code === "not_found" ? 404 : 400);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function route(neo: Neo, request: Request, url: URL): Promise<Response> {
  const { method } = request;
  const path = url.pathname;
  const agentId = DEFAULT_AGENT_ID;
  const is = (m: string, p: string) => method === m && path === p;
  const match = (m: string, pattern: RegExp) => (method === m ? pattern.exec(path) : null);
  let m: RegExpExecArray | null;

  if (is("GET", "/v1/status")) {
    const status: Record<string, unknown> = {
      version: NEO_VERSION,
      host: neo.host.name,
      state: neo.state,
      instanceId: neo.instanceId,
      capabilities: neo.host.capabilities,
      test: !!neo.host.test,
    };
    if (neo.state === "active") {
      const live = neo.services();
      const agent = await live.agents.get(agentId);
      status.agent = { id: agent.id, name: agent.name, paused: agent.paused };
      status.model = agent.model ?? (await neo.defaultModel()) ?? null;
      status.turn = (await live.mailbox.currentTurn(agentId)) ?? null;
      status.queued = (await live.mailbox.queue(agentId)).length;
      status.latestEvent = await neo.events.latest();
    }
    return json(status);
  }
  if (is("GET", "/v1/events")) {
    const after = Number(url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0) || 0;
    return new Response(neo.events.stream(after, request.signal), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  const live = neo.services();

  // ---- conversation ----
  if (is("POST", "/v1/messages")) {
    const input = await body<{ text?: string; clientId?: string; steer?: boolean }>(request);
    if (typeof input.text !== "string") throw new HttpError(400, "text is required");
    const steer = input.steer ?? (await live.settings.get("busyMessageMode")) === "steer";
    const message = await neo.send(agentId, {
      text: input.text,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      steer,
    });
    return json({ message }, 202);
  }
  if (is("GET", "/v1/transcript")) {
    const before = url.searchParams.get("before");
    const limit = url.searchParams.get("limit");
    return json(
      await readTranscript(await neo.conversation(agentId), live.mailbox, {
        ...(before ? { before: Number(before) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    );
  }
  if (is("GET", "/v1/live")) {
    // The running turn as it is now: the partial answer and tool calls not yet in the transcript.
    const conversation = await neo.conversation(agentId);
    const stream = await watchEvents(live.harness, conversation.id, BACKGROUND_CONTEXT);
    const { generation, tools, compactions, run } = stream.snapshot;
    await stream.stop();
    return json({
      turn: (await live.mailbox.currentTurn(agentId)) ?? null,
      run: run ?? null,
      generation: generation ?? null,
      tools,
      compactions,
    });
  }
  if ((m = match("GET", /^\/v1\/turns\/([\w-]+)$/))) {
    const turn = await live.mailbox.turn(m[1]!);
    if (!turn) throw new HttpError(404, "No such turn");
    return json({ turn, messages: await live.mailbox.turnMessages(turn.id) });
  }
  if (is("POST", "/v1/stop")) return json({ stopped: await live.mailbox.stop(agentId) });
  if (is("POST", "/v1/pause")) {
    await neo.pause(agentId);
    return json({ paused: true });
  }
  if (is("POST", "/v1/resume")) {
    await neo.resume(agentId);
    return json({ paused: false });
  }

  // ---- queue ----
  if (is("GET", "/v1/queue")) return json({ queue: await live.mailbox.queue(agentId) });
  if (is("PUT", "/v1/queue/order")) {
    const input = await body<{ order?: string[] }>(request);
    if (!Array.isArray(input.order)) throw new HttpError(400, "order is a list of message ids");
    return json({ queue: await live.mailbox.reorder(agentId, input.order) });
  }
  if ((m = match("PATCH", /^\/v1\/queue\/([\w-]+)$/))) {
    const input = await body<{ text?: string }>(request);
    if (typeof input.text !== "string") throw new HttpError(400, "text is required");
    return json({ message: await live.mailbox.edit(agentId, m[1]!, input.text) });
  }
  if ((m = match("DELETE", /^\/v1\/queue\/([\w-]+)$/))) {
    await live.mailbox.cancel(agentId, m[1]!);
    return json({ cancelled: m[1] });
  }
  if ((m = match("POST", /^\/v1\/queue\/([\w-]+)\/steer$/))) {
    await live.mailbox.steer(agentId, m[1]!);
    return json({ steered: m[1] });
  }

  // ---- memory ----
  if (is("GET", "/v1/memories")) {
    const q = url.searchParams.get("q");
    const memories = q
      ? await live.memories.search(agentId, q, 50)
      : await live.memories.list(agentId);
    return json({
      memories,
      count: await live.memories.count(agentId),
      limit: await live.settings.get("memoryLimit"),
    });
  }
  if (is("POST", "/v1/memories")) {
    const input = await body<{ text?: string; kind?: MemoryKind }>(request);
    if (typeof input.text !== "string") throw new HttpError(400, "text is required");
    const memory = await live.memories.add(agentId, input.text, input.kind ?? "searchable");
    await neo.events.emit("memory.changed", { added: memory.id }, agentId);
    return json({ memory }, 201);
  }
  if ((m = match("PATCH", /^\/v1\/memories\/([\w-]+)$/))) {
    const input = await body<{ text?: string; kind?: MemoryKind }>(request);
    const memory = await live.memories.update(agentId, m[1]!, input);
    if (!memory) throw new HttpError(404, "No such memory");
    await neo.events.emit("memory.changed", { updated: memory.id }, agentId);
    return json({ memory });
  }
  if ((m = match("DELETE", /^\/v1\/memories\/([\w-]+)$/))) {
    if (!(await live.memories.remove(agentId, m[1]!))) throw new HttpError(404, "No such memory");
    await neo.events.emit("memory.changed", { removed: m[1] }, agentId);
    return json({ removed: m[1] });
  }

  // ---- wake-ups ----
  if (is("GET", "/v1/wakeups")) {
    const status = (url.searchParams.get("status") ?? "pending") as "pending" | "all";
    return json({ wakeups: await live.wakeups.list(agentId, status) });
  }
  if (is("POST", "/v1/wakeups")) {
    const input = await body<{ note?: string; at?: string; inMinutes?: number }>(request);
    const at = wakeupTime(input, neo.now(), await live.settings.get("timezone"));
    const wakeup = await live.wakeups.add(agentId, at, input.note ?? "", "person");
    await neo.arm();
    await neo.events.emit("wakeup.changed", { added: wakeup.id }, agentId);
    return json({ wakeup }, 201);
  }
  if ((m = match("DELETE", /^\/v1\/wakeups\/([\w-]+)$/))) {
    if (!(await live.wakeups.cancel(agentId, m[1]!))) throw new HttpError(404, "No pending wake-up has that id");
    await neo.arm();
    await neo.events.emit("wakeup.changed", { cancelled: m[1] }, agentId);
    return json({ cancelled: m[1] });
  }

  // ---- agent and settings ----
  if (is("GET", "/v1/agent")) return json({ agent: await live.agents.get(agentId) });
  if (is("PATCH", "/v1/agent")) {
    const change = await body<AgentChange>(request);
    const before = await live.agents.get(agentId);
    const agent = await live.agents.update(agentId, change);
    if (JSON.stringify(before.heartbeat) !== JSON.stringify(agent.heartbeat))
      await neo.rescheduleHeartbeat(agentId);
    await neo.events.emit("agent.changed", {}, agentId);
    return json({ agent: await live.agents.get(agentId) });
  }
  if (is("GET", "/v1/settings")) return json({ settings: await live.settings.all() });
  if (is("PUT", "/v1/settings")) {
    const settings = await live.settings.update(await body<Partial<SettingsShape>>(request));
    await neo.events.emit("settings.changed", {});
    return json({ settings });
  }

  // ---- models ----
  if (is("GET", "/v1/providers")) return json({ providers: await live.providers.list() });
  if (is("GET", "/v1/providers/detect"))
    return json({ found: neo.host.capabilities.sockets ? await detectLocalProviders() : [] });
  if ((m = match("PUT", /^\/v1\/providers\/([\w-]+)$/))) {
    const config = await body<ProviderConfig>(request);
    await live.providers.put({ ...config, id: m[1]! });
    await neo.events.emit("providers.changed", {});
    return json({ providers: await live.providers.list() });
  }
  if ((m = match("DELETE", /^\/v1\/providers\/([\w-]+)$/))) {
    await live.providers.remove(m[1]!);
    await neo.events.emit("providers.changed", {});
    return json({ providers: await live.providers.list() });
  }
  if (is("GET", "/v1/models"))
    return json({ models: await live.providers.available(), default: (await neo.defaultModel()) ?? null });

  // ---- files ----
  if (path === "/v1/files") {
    const filePath = url.searchParams.get("path");
    if (!filePath) throw new HttpError(400, "path is required");
    if (method === "GET") {
      const stat = await live.vfs.stat(filePath);
      if (stat.kind === "directory")
        return json({ path: stat.path, entries: await live.vfs.readdir(stat.path, { limit: 1000 }) });
      return new Response(await live.vfs.readStream(stat.path), {
        headers: { "content-type": "application/octet-stream", "content-length": String(stat.size) },
      });
    }
    if (method === "PUT") {
      await live.vfs.writeFile(filePath, new Uint8Array(await request.arrayBuffer()), { createParents: true });
      return json({ written: filePath });
    }
    if (method === "DELETE") {
      await live.vfs.rm(filePath, { recursive: url.searchParams.get("recursive") === "1" });
      return json({ removed: filePath });
    }
  }

  // ---- test mode: script the fake model ----
  if (neo.host.test && is("POST", "/v1/test/script")) {
    const input = await body<{ steps: Parameters<NonNullable<typeof neo.host.test>["script"]>[0]; append?: boolean }>(request);
    neo.host.test.script(input.steps, { append: input.append ?? false });
    return json({ pending: neo.host.test.pending() });
  }
  if (neo.host.test && is("POST", "/v1/test/release")) {
    const input = await body<{ gate: string }>(request);
    neo.host.test.release(input.gate);
    return json({ released: input.gate });
  }
  if (neo.host.test && is("GET", "/v1/test/seen")) return json({ seen: neo.host.test.seen });
  if (neo.host.test && is("POST", "/v1/test/heartbeat-due")) {
    // The heartbeat is due now; the next wake sends it.
    await live.agents.setHeartbeatNext(agentId, neo.now() - 1);
    return json({ due: true });
  }
  if (neo.host.test && is("POST", "/v1/test/wake")) {
    await neo.wake();
    return json({ woke: true });
  }

  throw new HttpError(404, "Not found");
}
