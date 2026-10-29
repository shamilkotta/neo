import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { type AgentChange, DEFAULT_AGENT_ID } from "./agent/agents";
import { MailboxError } from "./agent/mailbox";
import { readTranscript } from "./agent/transcript";
import { ScheduleError, type ScheduleInput } from "./agent/schedules";
import { timingSafeEqual } from "./crypto";
import { type Neo, NEO_VERSION, SetupError, StateError } from "./neo";
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
    if (error instanceof MailboxError || error instanceof ScheduleError)
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
    const input = await body<{ text?: string; clientId?: string }>(request);
    if (typeof input.text !== "string") throw new HttpError(400, "text is required");
    const message = await neo.send(agentId, {
      text: input.text,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      steer: true,
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

  // ---- schedules (reminders, routines, the heartbeat) ----
  if (is("GET", "/v1/schedules")) return json({ schedules: await live.schedules.list(agentId) });
  // The agent manages its schedules; the person can only turn one on or off.
  if ((m = match("PATCH", /^\/v1\/schedules\/([\w-]+)$/))) {
    const input = await body<{ enabled?: boolean }>(request);
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled is required");
    const schedule = await live.schedules.update(agentId, m[1]!, { enabled: input.enabled }, await live.settings.get("timezone"));
    if (!schedule) throw new HttpError(404, "No such schedule");
    await neo.schedulesChanged(agentId);
    return json({ schedule });
  }
  if ((m = match("GET", /^\/v1\/schedules\/([\w-]+)\/runs$/))) {
    if (!(await live.schedules.get(agentId, m[1]!))) throw new HttpError(404, "No such schedule");
    return json({ runs: await live.schedules.runs(m[1]!) });
  }

  // ---- agent and settings ----
  if (is("GET", "/v1/agent")) return json({ agent: await live.agents.get(agentId) });
  if (is("PATCH", "/v1/agent")) {
    const change = await body<AgentChange>(request);
    await live.agents.update(agentId, change);
    await neo.events.emit("agent.changed", {}, agentId);
    return json({ agent: await live.agents.get(agentId) });
  }
  if (is("GET", "/v1/settings")) return json({ settings: await live.settings.all() });
  if (is("PUT", "/v1/settings")) {
    const before = await live.settings.get("timezone");
    const settings = await live.settings.update(await body<Partial<SettingsShape>>(request));
    if (settings.timezone !== before) await neo.timezoneChanged();
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
      // Streamed into the file store as it arrives: an upload is never held whole in memory.
      const stat = await live.vfs.writeStream(filePath, request.body ?? new Blob([]).stream(), { createParents: true });
      return json({ written: stat.path, size: stat.size });
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
  if (neo.host.test && is("POST", "/v1/test/messages")) {
    // Queued behind a running turn: the API always joins the turn.
    const input = await body<{ text?: string }>(request);
    if (typeof input.text !== "string") throw new HttpError(400, "text is required");
    return json({ message: await neo.send(agentId, { text: input.text, steer: false }) }, 202);
  }
  if (neo.host.test && is("GET", "/v1/test/memories")) return json({ memories: await live.memories.list(agentId) });
  if (neo.host.test && is("POST", "/v1/test/schedules")) {
    // As the agent would: the API has no way to create one.
    const input = await body<ScheduleInput>(request);
    const schedule = await live.schedules.create(agentId, input, "agent", await live.settings.get("timezone"));
    await neo.schedulesChanged(agentId);
    return json({ schedule }, 201);
  }
  if (neo.host.test && (m = match("PATCH", /^\/v1\/test\/schedules\/([\w-]+)$/))) {
    const schedule = await live.schedules.update(agentId, m[1]!, await body<ScheduleInput>(request), await live.settings.get("timezone"));
    if (!schedule) throw new HttpError(404, "No such schedule");
    await neo.schedulesChanged(agentId);
    return json({ schedule });
  }
  if (neo.host.test && (m = match("POST", /^\/v1\/test\/schedules\/([\w-]+)\/due$/))) {
    // Due now; the next wake fires it. "heartbeat" names the built-in one.
    const id = m[1] === "heartbeat" ? (await live.schedules.system(agentId, "heartbeat"))?.id : m[1];
    const ago = Number(url.searchParams.get("ago") ?? 1);
    if (!id || !(await live.schedules.dueNow(agentId, id, ago))) throw new HttpError(404, "No such schedule");
    return json({ due: id });
  }
  if (neo.host.test && is("POST", "/v1/test/wake")) {
    await neo.wake();
    return json({ woke: true });
  }

  throw new HttpError(404, "Not found");
}
