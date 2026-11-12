import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { AttachmentInput, QuestionAnswer, ScheduleInput } from "@neo/client";
import { Type } from "typebox";
import { ATTACHMENTS_ROOT, USER_ROOT } from "./agent/attachments";
import { readTranscript } from "./agent/transcript";
import { ScriptStep } from "./testing";
import { body, eventStream, HttpError, json, matcher, serve } from "./http";
import type { NeoAgent } from "./neo";
import { joinPath, type Vfs, type VfsStat } from "./vfs/vfs";

export { authorized, preflight, unauthorized } from "./http";

export function handleAgentApi(neo: NeoAgent, request: Request) {
  return serve(request, (request, url) => route(neo, request, url));
}

async function route(neo: NeoAgent, request: Request, url: URL) {
  const { method } = request;
  const path = url.pathname;
  const { is, param } = matcher(request, url);
  let id: string | undefined;

  if (neo.state === "empty") throw new HttpError(404, "No such agent");
  if (is("GET", "/status")) {
    const live = neo.state === "active" ? neo.services() : undefined;
    const self = live ? await live.self.get() : undefined;
    return json({
      agent: self
        ? { ...self.profile, paused: self.paused }
        : { id: neo.agentId },
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
    const upload = await neo.upload(
      name,
      request.body ?? new Blob([]).stream(),
    );
    return json({ upload }, 201);
  }
  if (is("POST", "/messages")) {
    const input = await body(request, MessageBody);
    if (input.answer) {
      if (input.text !== undefined || input.attachments?.length)
        throw new HttpError(400, "An answer has no text or attachments");
      return json(
        { message: await neo.answer(input.answer, input.clientId) },
        202,
      );
    }
    const files = input.attachments ?? [];
    if (typeof input.text !== "string" && !files.length)
      throw new HttpError(400, "text is required");
    const message = await neo.send({
      source: "user",
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
  if ((id = param("GET", /^\/turns\/([\w-]+)$/)) !== undefined) {
    const turn = await live.mailbox.turn(id);
    if (!turn) throw new HttpError(404, "No such turn");
    return json({ turn, messages: await live.mailbox.turnMessages(turn.id) });
  }
  if (is("POST", "/stop")) return json({ stopped: await live.mailbox.stop() });
  if (is("POST", "/pause")) {
    await neo.pause();
    return json({ paused: true });
  }
  if (is("POST", "/resume")) {
    await neo.resume();
    return json({ paused: false });
  }

  if (is("GET", "/queue")) return json({ queue: await live.mailbox.queue() });
  if (is("PUT", "/queue/order")) {
    const input = await body(
      request,
      Type.Object({ order: Type.Array(Type.String()) }),
    );
    return json({ queue: await live.mailbox.reorder(input.order) });
  }
  if ((id = param("PATCH", /^\/queue\/([\w-]+)$/)) !== undefined) {
    const input = await body(request, Type.Object({ text: Type.String() }));
    return json({
      message: await live.mailbox.edit(id, input.text),
    });
  }
  if ((id = param("DELETE", /^\/queue\/([\w-]+)$/)) !== undefined) {
    await live.mailbox.cancel(id);
    return json({ cancelled: id });
  }
  if ((id = param("POST", /^\/queue\/([\w-]+)\/steer$/)) !== undefined) {
    await live.mailbox.steer(id);
    return json({ steered: id });
  }

  if (is("GET", "/schedules"))
    return json({ schedules: await live.schedules.list() });
  if ((id = param("PATCH", /^\/schedules\/([\w-]+)$/)) !== undefined) {
    const input = await body(request, Type.Object({ enabled: Type.Boolean() }));
    const schedule = await live.schedules.update(
      id,
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
      if (relative === "/")
        await live.vfs.mkdir(USER_ROOT, { recursive: true });
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
    const input = await body(
      request,
      Type.Object({
        steps: Type.Array(ScriptStep),
        append: Type.Optional(Type.Boolean()),
      }),
    );
    neo.host.test.script(input.steps, { append: input.append ?? false });
    return json({ pending: neo.host.test.pending() });
  }
  if (neo.host.test && is("POST", "/test/release")) {
    const input = await body(request, Type.Object({ gate: Type.String() }));
    neo.host.test.release(input.gate);
    return json({ released: input.gate });
  }
  if (neo.host.test && is("GET", "/test/seen"))
    return json({ seen: neo.host.test.seen });
  if (neo.host.test && is("POST", "/test/messages")) {
    const input = await body(
      request,
      Type.Object({
        text: Type.String(),
        attachments: Type.Optional(Type.Array(AttachmentInput)),
      }),
    );
    const files = input.attachments ?? [];
    return json(
      {
        message: await neo.send({
          source: "user",
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
    const input = await body(request, ScheduleInput);
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
    (id = param("PATCH", /^\/test\/schedules\/([\w-]+)$/)) !== undefined
  ) {
    const schedule = await live.schedules.update(
      id,
      await body(request, ScheduleInput),
      await neo.timezone(),
    );
    if (!schedule) throw new HttpError(404, "No such schedule");
    await neo.schedulesChanged();
    return json({ schedule });
  }
  if (
    neo.host.test &&
    (id = param("POST", /^\/test\/schedules\/([\w-]+)\/due$/)) !== undefined
  ) {
    const scheduleId =
      id === "heartbeat" ? (await live.schedules.system("heartbeat"))?.id : id;
    const ago = Number(url.searchParams.get("ago") ?? 1);
    if (!scheduleId || !(await live.schedules.dueNow(scheduleId, ago)))
      throw new HttpError(404, "No such schedule");
    return json({ due: scheduleId });
  }
  if (
    neo.host.test &&
    (id = param("GET", /^\/test\/schedules\/([\w-]+)\/runs$/)) !== undefined
  ) {
    const runs = await neo.host.db.all(
      `SELECT status, reason FROM neo_schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC`,
      id,
    );
    return json({ runs });
  }
  if (neo.host.test && is("POST", "/test/wake")) {
    await neo.wake();
    return json({ woke: true });
  }

  throw new HttpError(404, "Not found");
}

const MessageBody = Type.Object({
  text: Type.Optional(Type.String()),
  clientId: Type.Optional(Type.String()),
  attachments: Type.Optional(Type.Array(AttachmentInput)),
  answer: Type.Optional(QuestionAnswer),
});

async function fileResponse(vfs: Vfs, stat: VfsStat) {
  return new Response(await vfs.readStream(stat.path), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
    },
  });
}
