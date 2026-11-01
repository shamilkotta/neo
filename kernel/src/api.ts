import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import {
  ATTACHMENTS_ROOT,
  type AttachmentInput,
  USER_ROOT,
} from "./agent/attachments";
import { readTranscript } from "./agent/transcript";
import type { ScheduleInput } from "./agent/schedules";
import {
  body,
  eventStream,
  HttpError,
  json,
  matcher,
  serve,
} from "./http";
import type { NeoAgent } from "./neo";
import { joinPath, type Vfs, type VfsStat } from "./vfs/vfs";

export { authorized, preflight, unauthorized } from "./http";

/** One agent's API. The host routes `/i/agents/<id>/…` here as `/…`. */
export function handleAgentApi(
  neo: NeoAgent,
  request: Request,
): Promise<Response> {
  return serve(request, (request, url) => route(neo, request, url));
}

async function route(
  neo: NeoAgent,
  request: Request,
  url: URL,
): Promise<Response> {
  const { method } = request;
  const path = url.pathname;
  const { is, match } = matcher(request, url);
  let m: RegExpExecArray | null;

  if (neo.state === "empty") throw new HttpError(404, "No such agent");
  if (is("GET", "/status")) {
    const live = neo.state === "active" ? neo.services() : undefined;
    const self = live ? await live.self.get() : undefined;
    return json({
      agent: self ? { ...self.profile, paused: self.paused } : { id: neo.agentId },
      state: neo.state,
      turn: (await live?.mailbox.currentTurn()) ?? null,
      queued: live ? (await live.mailbox.queue()).length : 0,
      latestEvent: await neo.events.latest(),
    });
  }
  if (is("GET", "/events")) return eventStream(neo.events, request, url);

  const live = neo.services();

  if (is("GET", "/agent")) {
    const self = await live.self.get();
    return json({ agent: { ...self.profile, paused: self.paused } });
  }
  if (is("POST", "/uploads")) {
    const name = url.searchParams.get("name");
    if (!name) throw new HttpError(400, "name is required");
    const upload = await neo.upload(name, request.body ?? new Blob([]).stream());
    return json({ upload }, 201);
  }
  if (is("POST", "/messages")) {
    const input = await body<{
      text?: string;
      clientId?: string;
      attachments?: AttachmentInput[];
    }>(request);
    const files = attachmentsOf(input);
    if (typeof input.text !== "string" && !files.length)
      throw new HttpError(400, "text is required");
    const message = await neo.send({
      text: input.text ?? "",
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(files.length ? { files } : {}),
      steer: true,
    });
    return json({ message }, 202);
  }
  if (is("GET", "/transcript")) {
    const before = url.searchParams.get("before");
    const limit = url.searchParams.get("limit");
    return json(
      await readTranscript(await neo.conversation(), live.mailbox, {
        ...(before ? { before: Number(before) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    );
  }
  if (is("GET", "/live")) {
    const conversation = await neo.conversation();
    const stream = await watchEvents(
      live.harness,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    const { generation, tools, compactions, run } = stream.snapshot;
    await stream.stop();
    return json({
      turn: (await live.mailbox.currentTurn()) ?? null,
      run: run ?? null,
      generation: generation ?? null,
      tools,
      compactions,
    });
  }
  if ((m = match("GET", /^\/turns\/([\w-]+)$/))) {
    const turn = await live.mailbox.turn(m[1]!);
    if (!turn) throw new HttpError(404, "No such turn");
    return json({ turn, messages: await live.mailbox.turnMessages(turn.id) });
  }
  if (is("POST", "/stop"))
    return json({ stopped: await live.mailbox.stop() });
  if (is("POST", "/pause")) {
    await neo.pause();
    return json({ paused: true });
  }
  if (is("POST", "/resume")) {
    await neo.resume();
    return json({ paused: false });
  }

  if (is("GET", "/queue"))
    return json({ queue: await live.mailbox.queue() });
  if (is("PUT", "/queue/order")) {
    const input = await body<{ order?: string[] }>(request);
    if (!Array.isArray(input.order))
      throw new HttpError(400, "order is a list of message ids");
    return json({ queue: await live.mailbox.reorder(input.order) });
  }
  if ((m = match("PATCH", /^\/queue\/([\w-]+)$/))) {
    const input = await body<{ text?: string }>(request);
    if (typeof input.text !== "string")
      throw new HttpError(400, "text is required");
    return json({
      message: await live.mailbox.edit(m[1]!, input.text),
    });
  }
  if ((m = match("DELETE", /^\/queue\/([\w-]+)$/))) {
    await live.mailbox.cancel(m[1]!);
    return json({ cancelled: m[1] });
  }
  if ((m = match("POST", /^\/queue\/([\w-]+)\/steer$/))) {
    await live.mailbox.steer(m[1]!);
    return json({ steered: m[1] });
  }

  if (is("GET", "/schedules"))
    return json({ schedules: await live.schedules.list() });
  if ((m = match("PATCH", /^\/schedules\/([\w-]+)$/))) {
    const input = await body<{ enabled?: boolean }>(request);
    if (typeof input.enabled !== "boolean")
      throw new HttpError(400, "enabled is required");
    const schedule = await live.schedules.update(
            m[1]!,
      { enabled: input.enabled },
      await neo.timezone(),
    );
    if (!schedule) throw new HttpError(404, "No such schedule");
    await neo.schedulesChanged();
    return json({ schedule });
  }

  if (path === "/files") {
    const given = url.searchParams.get("path");
    if (!given) throw new HttpError(400, "path is required");
    const relative = joinPath("/", given);
    const filePath = relative === "/" ? USER_ROOT : USER_ROOT + relative;
    const outside = (p: string) => p.slice(USER_ROOT.length) || "/";
    if (method === "GET") {
      if (relative === "/") await live.vfs.mkdir(USER_ROOT, { recursive: true });
      const stat = await live.vfs.stat(filePath);
      if (stat.kind === "directory")
        return json({
          path: relative,
          entries: (await live.vfs.readdir(stat.path, { limit: 1000 })).map(
            (e) => ({ ...e, path: outside(e.path) }),
          ),
        });
      return fileResponse(live.vfs, stat);
    }
    if (method === "DELETE") {
      if (relative === "/") throw new HttpError(400, "path is a folder");
      await live.vfs.rm(filePath, {
        recursive: url.searchParams.get("recursive") === "1",
      });
      return json({ removed: relative });
    }
  }
  if (is("GET", "/attachments")) {
    const given = url.searchParams.get("path");
    if (!given) throw new HttpError(400, "path is required");
    const filePath = joinPath("/", given);
    if (!filePath.startsWith(`${ATTACHMENTS_ROOT}/`))
      throw new HttpError(404, "Not an attachment");
    const stat = await live.vfs.stat(filePath);
    if (stat.kind !== "file") throw new HttpError(404, "Not an attachment");
    return fileResponse(live.vfs, stat);
  }

  if (neo.host.test && is("POST", "/test/script")) {
    const input = await body<{
      steps: Parameters<NonNullable<typeof neo.host.test>["script"]>[0];
      append?: boolean;
    }>(request);
    neo.host.test.script(input.steps, { append: input.append ?? false });
    return json({ pending: neo.host.test.pending() });
  }
  if (neo.host.test && is("POST", "/test/release")) {
    const input = await body<{ gate: string }>(request);
    neo.host.test.release(input.gate);
    return json({ released: input.gate });
  }
  if (neo.host.test && is("GET", "/test/seen"))
    return json({ seen: neo.host.test.seen });
  if (neo.host.test && is("POST", "/test/messages")) {
    const input = await body<{
      text?: string;
      attachments?: AttachmentInput[];
    }>(request);
    const files = attachmentsOf(input);
    if (typeof input.text !== "string")
      throw new HttpError(400, "text is required");
    return json(
      {
        message: await neo.send({
          text: input.text,
          ...(files.length ? { files } : {}),
          steer: false,
        }),
      },
      202,
    );
  }
  if (neo.host.test && is("GET", "/test/memories"))
    return json({ memories: await live.memories.list() });
  if (neo.host.test && is("POST", "/test/schedules")) {
    const input = await body<ScheduleInput>(request);
    const schedule = await live.schedules.create(
            input,
      "agent",
      await neo.timezone(),
    );
    await neo.schedulesChanged();
    return json({ schedule }, 201);
  }
  if (
    neo.host.test &&
    (m = match("PATCH", /^\/test\/schedules\/([\w-]+)$/))
  ) {
    const schedule = await live.schedules.update(
            m[1]!,
      await body<ScheduleInput>(request),
      await neo.timezone(),
    );
    if (!schedule) throw new HttpError(404, "No such schedule");
    await neo.schedulesChanged();
    return json({ schedule });
  }
  if (
    neo.host.test &&
    (m = match("POST", /^\/test\/schedules\/([\w-]+)\/due$/))
  ) {
    const id =
      m[1] === "heartbeat"
        ? (await live.schedules.system("heartbeat"))?.id
        : m[1];
    const ago = Number(url.searchParams.get("ago") ?? 1);
    if (!id || !(await live.schedules.dueNow(id, ago)))
      throw new HttpError(404, "No such schedule");
    return json({ due: id });
  }
  if (
    neo.host.test &&
    (m = match("GET", /^\/test\/schedules\/([\w-]+)\/runs$/))
  ) {
    const runs = await neo.host.db.all(
      `SELECT status, reason FROM neo_schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC`,
      m[1]!,
    );
    return json({ runs });
  }
  if (neo.host.test && is("POST", "/test/wake")) {
    await neo.wake();
    return json({ woke: true });
  }

  throw new HttpError(404, "Not found");
}

function attachmentsOf(input: { attachments?: unknown }): AttachmentInput[] {
  if (input.attachments === undefined) return [];
  if (!Array.isArray(input.attachments))
    throw new HttpError(400, "attachments is a list of { id, mimeType? }");
  return input.attachments as AttachmentInput[];
}

async function fileResponse(vfs: Vfs, stat: VfsStat): Promise<Response> {
  return new Response(await vfs.readStream(stat.path), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
    },
  });
}
