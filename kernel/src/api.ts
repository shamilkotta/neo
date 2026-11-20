import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import {
  AttachmentInput,
  QuestionAnswer,
  RecordId,
  ScheduleInput,
} from "@neo/client";
import { Hono } from "hono";
import { Type } from "typebox";
import { ATTACHMENTS_ROOT, USER_ROOT } from "./agent/attachments";
import { readTranscript } from "./agent/transcript";
import { api, HttpError, jsonBody, pathParams, queryParams } from "./http";
import type { NeoAgent } from "./neo";
import { ScriptStep } from "./testing";
import { joinPath, type Vfs, type VfsStat } from "./vfs/vfs";

const MessageBody = Type.Object({
  text: Type.Optional(Type.String()),
  clientId: Type.Optional(Type.String()),
  attachments: Type.Optional(Type.Array(AttachmentInput)),
  answer: Type.Optional(QuestionAnswer),
});

const ById = pathParams(Type.Object({ id: RecordId }));
const Position = Type.Integer({ minimum: 0 });
const TranscriptQuery = Type.Object({
  before: Type.Optional(Position),
  from: Type.Optional(Position),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const UploadQuery = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
});
const FileQuery = Type.Object({ path: Type.String({ minLength: 1 }) });
const RemoveQuery = Type.Object({
  path: Type.String({ minLength: 1 }),
  recursive: Type.Optional(Type.Boolean()),
});

export function agentApi(neo: NeoAgent) {
  const app = api();
  const live = () => neo.services();

  app.use(async (_c, next) => {
    if (neo.state === "empty") throw new HttpError(404, "No such agent");
    await next();
  });

  app.get("/status", async (c) => {
    const services = neo.state === "active" ? live() : undefined;
    const self = services ? await services.self.get() : undefined;
    return c.json({
      agent: self
        ? { ...self.profile, paused: self.paused }
        : { id: neo.agentId },
      state: neo.state,
      turn: (await services?.mailbox.currentTurn()) ?? null,
      queued: services ? (await services.mailbox.queue()).length : 0,
    });
  });

  app.get("/agent", async (c) => {
    const self = await live().self.get();
    return c.json({ agent: { ...self.profile, paused: self.paused } });
  });

  app.post("/uploads", queryParams(UploadQuery), async (c) => {
    const upload = await neo.upload(
      c.req.valid("query").name,
      c.req.raw.body ?? new Blob([]).stream(),
    );
    return c.json({ upload }, 201);
  });

  app.post("/messages", jsonBody(MessageBody), async (c) => {
    const input = c.req.valid("json");
    if (input.answer) {
      if (input.text !== undefined || input.attachments?.length)
        throw new HttpError(400, "An answer has no text or attachments");
      return c.json(
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
    return c.json({ message }, 202);
  });

  app.get("/transcript", queryParams(TranscriptQuery), async (c) =>
    c.json(
      await readTranscript(
        await neo.conversation(),
        live().mailbox,
        c.req.valid("query"),
      ),
    ),
  );

  app.get("/live", async (c) => {
    const { harness, mailbox } = live();
    const conversation = await neo.conversation();
    const stream = await watchEvents(
      harness,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    const { generation, tools, compactions, run } = stream.snapshot;
    await stream.stop();
    return c.json({
      turn: (await mailbox.currentTurn()) ?? null,
      run: run ?? null,
      generation: generation ?? null,
      tools,
      compactions,
    });
  });

  app.get("/turns/:id", ById, async (c) => {
    const { mailbox } = live();
    const turn = await mailbox.turn(c.req.valid("param").id);
    if (!turn) throw new HttpError(404, "No such turn");
    return c.json({ turn, messages: await mailbox.turnMessages(turn.id) });
  });

  app.post("/stop", async (c) =>
    c.json({ stopped: await live().mailbox.stop() }),
  );
  app.post("/pause", async (c) => {
    await neo.pause();
    return c.json({ paused: true });
  });
  app.post("/resume", async (c) => {
    await neo.resume();
    return c.json({ paused: false });
  });

  app.get("/queue", async (c) =>
    c.json({ queue: await live().mailbox.queue() }),
  );
  app.put(
    "/queue/order",
    jsonBody(Type.Object({ order: Type.Array(Type.String()) })),
    async (c) =>
      c.json({
        queue: await live().mailbox.reorder(c.req.valid("json").order),
      }),
  );
  app.patch(
    "/queue/:id",
    ById,
    jsonBody(Type.Object({ text: Type.String() })),
    async (c) =>
      c.json({
        message: await live().mailbox.edit(
          c.req.valid("param").id,
          c.req.valid("json").text,
        ),
      }),
  );
  app.delete("/queue/:id", ById, async (c) => {
    const id = c.req.valid("param").id;
    await live().mailbox.cancel(id);
    return c.json({ cancelled: id });
  });
  app.post("/queue/:id/steer", ById, async (c) => {
    const id = c.req.valid("param").id;
    await live().mailbox.steer(id);
    return c.json({ steered: id });
  });

  app.get("/schedules", async (c) =>
    c.json({ schedules: await live().schedules.list() }),
  );
  app.patch(
    "/schedules/:id",
    ById,
    jsonBody(Type.Object({ enabled: Type.Boolean() })),
    async (c) => {
      const schedule = await live().schedules.update(
        c.req.valid("param").id,
        { enabled: c.req.valid("json").enabled },
        await neo.timezone(),
      );
      if (!schedule) throw new HttpError(404, "No such schedule");
      await neo.schedulesChanged();
      return c.json({ schedule });
    },
  );

  app.get("/files", queryParams(FileQuery), async (c) => {
    const { vfs } = live();
    const file = userFile(c.req.valid("query").path);
    if (file.relative === "/") await vfs.mkdir(USER_ROOT, { recursive: true });
    const stat = await vfs.stat(file.path);
    if (stat.kind !== "directory") return fileResponse(vfs, stat);
    const entries = await vfs.readdir(stat.path, { limit: 1000 });
    return c.json({
      path: file.relative,
      entries: entries.map((e) => ({ ...e, path: outsidePath(e.path) })),
    });
  });
  app.delete("/files", queryParams(RemoveQuery), async (c) => {
    const { path, recursive } = c.req.valid("query");
    const file = userFile(path);
    if (file.relative === "/") throw new HttpError(400, "path is a folder");
    await live().vfs.rm(file.path, { recursive: recursive ?? false });
    return c.json({ removed: file.relative });
  });

  app.get("/attachments", queryParams(FileQuery), async (c) => {
    const { vfs } = live();
    const path = joinPath("/", c.req.valid("query").path);
    if (!path.startsWith(`${ATTACHMENTS_ROOT}/`))
      throw new HttpError(404, "Not an attachment");
    const stat = await vfs.stat(path);
    if (stat.kind !== "file") throw new HttpError(404, "Not an attachment");
    return fileResponse(vfs, stat);
  });

  if (neo.host.test) app.route("/test", testApi(neo, neo.host.test));
  return app;
}

type TestHooks = NonNullable<NeoAgent["host"]["test"]>;

function testApi(neo: NeoAgent, test: TestHooks) {
  const app = new Hono();
  const live = () => neo.services();

  app.post(
    "/script",
    jsonBody(
      Type.Object({
        steps: Type.Array(ScriptStep),
        append: Type.Optional(Type.Boolean()),
      }),
    ),
    (c) => {
      const input = c.req.valid("json");
      test.script(input.steps, { append: input.append ?? false });
      return c.json({ pending: test.pending() });
    },
  );
  app.post("/release", jsonBody(Type.Object({ gate: Type.String() })), (c) => {
    const { gate } = c.req.valid("json");
    test.release(gate);
    return c.json({ released: gate });
  });
  app.get("/seen", (c) => c.json({ seen: test.seen }));
  app.post(
    "/messages",
    jsonBody(
      Type.Object({
        text: Type.String(),
        attachments: Type.Optional(Type.Array(AttachmentInput)),
      }),
    ),
    async (c) => {
      const input = c.req.valid("json");
      const files = input.attachments ?? [];
      const message = await neo.send({
        source: "user",
        text: input.text,
        ...(files.length ? { files } : {}),
        steer: false,
      });
      return c.json({ message }, 202);
    },
  );
  app.get("/memories", async (c) =>
    c.json({ memories: await live().memories.list() }),
  );
  app.post("/schedules", jsonBody(ScheduleInput), async (c) => {
    const schedule = await live().schedules.create(
      c.req.valid("json"),
      "agent",
      await neo.timezone(),
    );
    await neo.schedulesChanged();
    return c.json({ schedule }, 201);
  });
  app.patch("/schedules/:id", ById, jsonBody(ScheduleInput), async (c) => {
    const schedule = await live().schedules.update(
      c.req.valid("param").id,
      c.req.valid("json"),
      await neo.timezone(),
    );
    if (!schedule) throw new HttpError(404, "No such schedule");
    await neo.schedulesChanged();
    return c.json({ schedule });
  });
  app.post(
    "/schedules/:id/due",
    ById,
    queryParams(
      Type.Object({ ago: Type.Optional(Type.Integer({ minimum: 0 })) }),
    ),
    async (c) => {
      const { schedules } = live();
      const id = c.req.valid("param").id;
      const scheduleId =
        id === "heartbeat" ? (await schedules.system("heartbeat"))?.id : id;
      const ago = c.req.valid("query").ago ?? 1;
      if (!scheduleId || !(await schedules.dueNow(scheduleId, ago)))
        throw new HttpError(404, "No such schedule");
      return c.json({ due: scheduleId });
    },
  );
  app.get("/schedules/:id/runs", ById, async (c) => {
    const runs = await neo.host.db.all(
      `SELECT status, reason FROM neo_schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC`,
      c.req.valid("param").id,
    );
    return c.json({ runs });
  });
  app.post("/wake", async (c) => {
    await neo.wake();
    return c.json({ woke: true });
  });
  return app;
}

function userFile(given: string) {
  const relative = joinPath("/", given);
  return {
    relative,
    path: relative === "/" ? USER_ROOT : USER_ROOT + relative,
  };
}

const outsidePath = (path: string) => path.slice(USER_ROOT.length) || "/";

async function fileResponse(vfs: Vfs, stat: VfsStat) {
  return new Response(await vfs.readStream(stat.path), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
    },
  });
}
