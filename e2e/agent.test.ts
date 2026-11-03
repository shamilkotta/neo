import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  answers,
  idle,
  type Instance,
  instance,
  running,
  transcript,
  until,
  AgentState,
  TranscriptPage,
  Seen,
  Queue,
  Schedules,
  Memories,
  Queued,
  OneSchedule,
  Runs,
  TurnDetail,
  Stopped,
  Upload,
  itemAs,
  itemsOf,
  toolResults,
} from "./harness";
import { agentId, parse, parseJson, type ScheduleInput } from "@neo/client";
import type { ScriptStep } from "@neo/kernel/testing";
import { Type } from "typebox";
import Value from "typebox/value";

let neo: Instance;
beforeEach(async () => {
  neo = await instance();
});
afterEach(async () => {
  await neo.close();
});

const script = (steps: ScriptStep[], append = false) =>
  neo.act("POST", "/test/script", { steps, append });
const send = (text: string, extra: { clientId?: string } = {}) =>
  neo
    .call("POST", "/messages", Queued, { text, ...extra })
    .then((r) => r.message);
const enqueue = (text: string) =>
  neo.call("POST", "/test/messages", Queued, { text }).then((r) => r.message);
const newSchedule = (input: ScheduleInput) =>
  neo
    .call("POST", "/test/schedules", OneSchedule, input)
    .then((r) => r.schedule);

describe("turns", () => {
  test("a message runs one turn: tool steps, answer, transcript", async () => {
    await script([{ step: 1 }, { text: "hello back" }]);
    await send("hi");
    await idle(neo);
    const items = await transcript(neo);
    expect(items.map((i) => i.type)).toEqual([
      "input",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(itemAs(items[0], "input").messages[0]?.text).toBe("hi");
    expect(itemAs(items[2], "tool").output).toBe("step 1 ok");
    expect(itemAs(items[3], "assistant").text).toBe("hello back");
  });

  test("a retried send with the same clientId is one message", async () => {
    await script([{ text: "once" }]);
    const a = await send("hi", { clientId: "c-1" });
    const b = await send("hi", { clientId: "c-1" });
    expect(b.id).toBe(a.id);
    await idle(neo);
    expect(await answers(neo)).toEqual(["once"]);
  });

  test("the model sees each message with a header (who, when)", async () => {
    await script([{ recall: "ok" }]);
    await send("what time is it");
    await idle(neo);
    const { seen } = await neo.call("GET", "/test/seen", Seen);
    expect(seen.at(-1)).toContain("[Message from the person ·");
    expect(seen.at(-1)).toContain("what time is it");
  });
});

describe("queue", () => {
  test("a message joins the running turn", async () => {
    await script([{ gate: "g" }, { recall: "saw it" }]);
    await send("start work");
    await running(neo);
    const steered = await send("also do X");
    await neo.act("POST", "/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual(["saw it"]);
    const { seen } = await neo.call("GET", "/test/seen", Seen);
    expect(seen.at(-1)).toContain("also do X");
    expect(seen.at(-1)).toContain("arrived while you were working");
    const [first] = await transcript(neo);
    const turn = await neo.call("GET", `/turns/${first?.turnId}`, TurnDetail);
    expect(turn.messages.map((m) => [m.text, m.status])).toEqual([
      ["start work", "completed"],
      ["also do X", "completed"],
    ]);
    expect(turn.messages[1]?.id).toBe(steered.id);
  });

  test("stop interrupts the turn; the queue moves on", async () => {
    await script([{ gate: "never" }, { text: "next turn ran" }]);
    await send("long job");
    await running(neo);
    await enqueue("after");
    expect((await neo.call("POST", "/stop", Stopped)).stopped).toBe(true);
    await idle(neo);
    const inputs = await itemsOf(neo, "input");
    const { turns } = await neo.call("GET", "/transcript", TranscriptPage);
    expect(turns[inputs[0]?.turnId ?? ""]?.status).toBe("interrupted");
    expect(turns[inputs[1]?.turnId ?? ""]?.status).toBe("completed");
    expect(await answers(neo)).toEqual(["next turn ran"]);
  });

  test("pause holds the queue; resume drains it", async () => {
    await script([{ text: "ran after resume" }]);
    await neo.act("POST", "/pause");
    await send("while paused");
    await Bun.sleep(150);
    expect((await neo.call("GET", "/status", AgentState)).queued).toBe(1);
    await neo.act("POST", "/resume");
    await idle(neo);
    expect(await answers(neo)).toEqual(["ran after resume"]);
  });
});

describe("memory", () => {
  const memories = async () =>
    (await neo.call("GET", "/test/memories", Memories)).memories;

  test("memories an agent saves commit when its turn completes, and are in the next prompt", async () => {
    await script([
      {
        tool: "remember",
        args: {
          text: "The person's dog is called Biscuit",
          inclusion: "essential",
        },
      },
      { text: "noted" },
      { recall: "ok" },
    ]);
    await send("my dog is Biscuit");
    await idle(neo);
    expect((await memories()).map((m) => [m.text, m.kind, m.origin])).toEqual([
      ["The person's dog is called Biscuit", "essential", "automatic"],
    ]);
    await send("hello again");
    await idle(neo);
    const { seen } = await neo.call("GET", "/test/seen", Seen);
    expect(seen.at(-1)).toContain("Biscuit");
  });

  test("remember with a made-up memoryId fails clearly, and a retry without it saves", async () => {
    await script([
      {
        tool: "remember",
        args: {
          memoryId: "person_name",
          text: "The person's name is Shamil",
          inclusion: "essential",
        },
      },
      { tool: "remember", args: { text: "The person's name is Shamil" } },
      { text: "noted" },
    ]);
    await send("my name is Shamil");
    await idle(neo);
    const failed = (await toolResults(neo)).find(
      (i) => i.name === "remember" && i.isError,
    );
    expect(failed?.output).toContain("without memoryId");
    expect((await memories()).map((m) => m.text)).toEqual([
      "The person's name is Shamil",
    ]);
  });

  test("memories staged in an interrupted turn are dropped", async () => {
    await script([
      { tool: "remember", args: { text: "should not be kept" } },
      { gate: "never" },
    ]);
    await send("remember something then hang");
    await until(
      async () =>
        (await transcript(neo)).some(
          (i) => i.type === "tool" && i.name === "remember",
        ),
      5000,
      "remember ran",
    );
    await neo.act("POST", "/stop");
    await idle(neo);
    expect(await memories()).toEqual([]);
  });
});

describe("schedules", () => {
  const schedules = async () =>
    (await neo.call("GET", "/schedules", Schedules)).schedules;
  const heartbeat = async () => {
    const found = (await schedules()).find((s) => s.system === "heartbeat");
    if (!found) throw new Error("No heartbeat");
    return found;
  };
  const scheduleById = async (id: string) => {
    const found = (await schedules()).find((s) => s.id === id);
    if (!found) throw new Error(`No schedule ${id}`);
    return found;
  };
  const runs = async (id: string) =>
    (await neo.call("GET", `/test/schedules/${id}/runs`, Runs)).runs;
  const due = (id: string, ago = 1) =>
    neo.act("POST", `/test/schedules/${id}/due?ago=${ago}`);
  const wake = () => neo.act("POST", "/test/wake");

  test("a reminder the agent creates comes back as a message, once", async () => {
    await script([
      {
        tool: "create_schedule",
        args: { prompt: "check the oven", inMinutes: 0.005 },
      },
      { text: "will check" },
      { recall: "checked the oven" },
    ]);
    await send("remind yourself to check the oven");
    await idle(neo);
    const reminder = (await schedules()).find(
      (s) => s.prompt === "check the oven",
    );
    expect(reminder).toMatchObject({
      createdBy: "agent",
      spec: { kind: "once" },
    });
    await Bun.sleep(400);
    await wake();
    await idle(neo);
    expect(await answers(neo)).toEqual(["will check", "checked the oven"]);
    const last = (await itemsOf(neo, "input")).at(-1);
    expect(last?.messages[0]).toMatchObject({
      source: "schedule",
      text: "check the oven",
    });
    const after = await scheduleById(reminder?.id ?? "");
    expect(after).toMatchObject({ nextAt: null, enabled: false, runCount: 1 });
  });

  test("the alarm fires a due schedule by itself", async () => {
    await script([{ text: "woke up" }]);
    await neo.act("POST", "/test/schedules", {
      prompt: "ping",
      inMinutes: 0.01,
    });
    await until(
      async () => (await answers(neo)).includes("woke up") || undefined,
      8000,
      "the scheduled turn",
    );
  });

  test("every agent has a heartbeat; quiet when nothing, shown when news", async () => {
    const hb = await heartbeat();
    expect(hb).toMatchObject({
      enabled: true,
      quiet: true,
      whenBusy: "skip",
      spec: { kind: "every", minutes: 60 },
    });
    await neo.act("PATCH", `/test/schedules/${hb.id}`, { window: null });
    await script([{ text: "QUIET_OK" }]);
    await due(hb.id);
    await wake();
    await idle(neo);
    expect(await transcript(neo)).toEqual([]);
    await script([{ text: "Your 3pm meeting moved" }]);
    await due(hb.id);
    await wake();
    await idle(neo);
    expect(await answers(neo)).toEqual(["Your 3pm meeting moved"]);
    expect((await heartbeat()).nextAt).toBeGreaterThan(
      Date.now() + 55 * 60_000,
    );
    expect((await runs(hb.id)).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(neo.act("PATCH", `/schedules/${hb.id}`, {})).rejects.toThrow(
      /enabled/,
    );
    expect(neo.act("DELETE", `/schedules/${hb.id}`)).rejects.toThrow();
    await neo.act("PATCH", `/schedules/${hb.id}`, { enabled: false });
    expect((await heartbeat()).nextAt).toBeNull();
  });

  test("the agent can change its own heartbeat and create a routine", async () => {
    const hb = await heartbeat();
    await script([
      {
        tool: "update_schedule",
        args: { scheduleId: hb.id, everyMinutes: 15 },
      },
      {
        tool: "create_schedule",
        args: {
          name: "Weekly review",
          prompt: "review the week",
          cron: "0 9 * * 1",
        },
      },
      { text: "done" },
    ]);
    await send(
      "check on me every 15 minutes, and review the week every Monday",
    );
    await idle(neo);
    expect((await heartbeat()).spec).toEqual({ kind: "every", minutes: 15 });
    const weekly = (await schedules()).find((s) => s.name === "Weekly review");
    expect(weekly?.spec).toEqual({ kind: "cron", expr: "0 9 * * 1" });
    expect(weekly?.nextAt).toBeGreaterThan(Date.now());
  });

  test("a routine repeats; one occurrence fires once however often the alarm rings", async () => {
    await script([{ text: "first" }]);
    const schedule = await newSchedule({ prompt: "routine", everyMinutes: 30 });
    await due(schedule.id);
    await Promise.all([wake(), wake(), wake()]);
    await idle(neo);
    await wake();
    await idle(neo);
    expect(await answers(neo)).toEqual(["first"]);
    const after = await scheduleById(schedule.id);
    expect(after.runCount).toBe(1);
    expect(after.nextAt).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  test("busy and backlog: the heartbeat skips, a routine does not pile up", async () => {
    const hb = await heartbeat();
    await neo.act("PATCH", `/test/schedules/${hb.id}`, { window: null });
    const schedule = await newSchedule({ prompt: "routine", everyMinutes: 30 });
    await neo.act("POST", "/pause");
    await due(hb.id);
    await due(schedule.id, 2000);
    await wake();
    await due(schedule.id, 1000);
    await wake();
    expect((await runs(hb.id)).map((r) => r.reason)).toEqual(["busy"]);
    expect((await runs(schedule.id)).map((r) => [r.status, r.reason])).toEqual([
      ["skipped", "previous_pending"],
      ["sent", null],
    ]);
    expect((await neo.call("GET", "/queue", Queue)).queue).toHaveLength(1);
  });

  test("after downtime: missed skip skips, missed run runs once late", async () => {
    await script([{ recall: "ran late" }]);
    const skip = await newSchedule({
      prompt: "skip me",
      everyMinutes: 30,
      missed: "skip",
    });
    const run = await newSchedule({ prompt: "run me", everyMinutes: 30 });
    const day = 24 * 60 * 60_000;
    await due(skip.id, day);
    await due(run.id, day);
    await wake();
    await idle(neo);
    expect((await runs(skip.id)).map((r) => r.reason)).toEqual(["missed"]);
    expect((await runs(run.id)).map((r) => r.status)).toEqual(["sent"]);
    expect(await itemsOf(neo, "input")).toHaveLength(1);
    expect((await neo.call("GET", "/test/seen", Seen)).seen.at(-1)).toContain(
      "was due",
    );
    for (const s of [skip, run])
      expect((await scheduleById(s.id)).nextAt).toBeGreaterThan(Date.now());
  });

  test("bad schedules are refused with a reason", async () => {
    const bad = (input: ScheduleInput) =>
      neo.act("POST", "/test/schedules", input);
    expect(bad({ prompt: "x", cron: "* * * * *" })).rejects.toThrow(
      /at most every 5 minutes/,
    );
    expect(bad({ prompt: "x", everyMinutes: 1 })).rejects.toThrow(/at least 5/);
    expect(bad({ prompt: "x", at: "2020-01-01T09:00" })).rejects.toThrow(
      /passed/,
    );
    expect(bad({ prompt: "x" })).rejects.toThrow(/Say when/);
    expect(
      bad({ prompt: "x", inMinutes: 5, cron: "0 9 * * *" }),
    ).rejects.toThrow(/one of/);
  });

  test("a cron follows the person's timezone when it changes", async () => {
    await neo.root.act("PUT", "/settings", { timezone: "UTC" });
    const schedule = await newSchedule({ prompt: "x", cron: "0 9 * * *" });
    expect(new Date(schedule.nextAt ?? 0).getUTCHours()).toBe(9);
    await neo.root.act("PUT", "/settings", { timezone: "Asia/Kolkata" });
    const moved = await scheduleById(schedule.id);
    expect(new Date(moved.nextAt ?? 0).getUTCHours()).toBe(3);
    expect(new Date(moved.nextAt ?? 0).getUTCMinutes()).toBe(30);
  });

  test("schedules survive a restart and still fire", async () => {
    if (!neo.restart) return;
    const schedule = await newSchedule({
      prompt: "after restart",
      everyMinutes: 30,
    });
    await neo.restart();
    expect((await scheduleById(schedule.id)).nextAt).toBe(schedule.nextAt);
    await script([{ text: "fired after restart" }]);
    await due(schedule.id);
    await wake();
    await idle(neo);
    expect(await answers(neo)).toEqual(["fired after restart"]);
    expect(
      (await schedules()).filter((s) => s.system === "heartbeat"),
    ).toHaveLength(1);
  });
});

describe("files", () => {
  test("the shell works on the workspace", async () => {
    await script([
      {
        tool: "bash",
        args: {
          command:
            "mkdir -p /notes && echo 'buy milk' > /notes/todo.txt && wc -l /notes/todo.txt",
        },
      },
      { text: "saved" },
    ]);
    await send("note: buy milk");
    await idle(neo);
    const [tool] = await toolResults(neo);
    expect(tool?.output).toContain("1 /notes/todo.txt");
    await expect(neo.act("GET", "/files?path=/notes")).rejects.toThrow();
  });
});

describe("recovery", () => {
  test("a turn cut off mid-tool resumes after a restart", async () => {
    if (!neo.restart) return;
    await script([{ gate: "g" }, { text: "unused" }]);
    await send("long job");
    await until(
      async () => (await transcript(neo)).some((i) => i.type === "assistant"),
      5000,
      "the tool call",
    );
    await enqueue("queued behind it");
    await neo.restart();
    await script([
      { text: "resumed after restart" },
      { text: "then the queue" },
    ]);
    await neo.act("POST", "/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual([
      "resumed after restart",
      "then the queue",
    ]);
    const { turns } = await neo.call("GET", "/transcript", TranscriptPage);
    expect(Object.values(turns).map((t) => t.status)).toEqual([
      "completed",
      "completed",
    ]);
  });
});

describe("client", () => {
  test("NeoClient follows the event stream", async () => {
    const status = await neo.call("GET", "/status", AgentState);
    const client = neo.client().agent(agentId("neo"));
    const seen: string[] = [];
    const stop = client.events(
      {
        durable: (e) => seen.push(e.type),
        live: (e) =>
          seen.push(
            `live:${Value.Check(Type.Object({ type: Type.String() }), e.data) ? e.data.type : "?"}`,
          ),
      },
      status.latestEvent,
    );
    await script([{ text: "streamed" }]);
    await client.send("hi");
    await until(async () => seen.includes("turn.ended"), 5000, "turn.ended");
    stop();
    expect(seen).toContain("message.queued");
    expect(seen).toContain("live:run_start");
  });
});

describe("file store", () => {
  test("a large file streams into the blob store and back intact", async () => {
    const size = 3 * 1024 * 1024 + 123;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536)
      crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
    const put = await neo.fetch(`${neo.agentUrl()}/uploads?name=data.bin`, {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: bytes,
    });
    const { upload } = parse(Upload, await put.json());
    expect(upload).toMatchObject({ name: "data.bin", size });
    const got = new Uint8Array(
      await (
        await neo.fetch(
          `${neo.agentUrl()}/files?path=/.staging/${upload.id}/data.bin`,
          {
            headers: { authorization: "Bearer t" },
          },
        )
      ).arrayBuffer(),
    );
    expect(got.length).toBe(size);
    expect(Bun.hash(got)).toBe(Bun.hash(bytes));
  });
});

describe("bounded memory", () => {
  test("history search finds old messages through the index", async () => {
    await script([
      { text: "Noted: the wifi password is on the fridge" },
      { text: "ok" },
    ]);
    await send("where did I leave the wifi password?");
    await idle(neo);
    await send("something else");
    await idle(neo);
    await script([
      { tool: "history_search", args: { query: "wif fridg" } },
      { text: "found" },
    ]);
    await send("search history");
    await idle(neo);
    const tool = (await toolResults(neo)).find(
      (i) => i.name === "history_search",
    );
    const found = parseJson(
      Type.Object({
        results: Type.Array(
          Type.Object({ role: Type.String(), excerpt: Type.String() }),
        ),
      }),
      tool?.output ?? "",
    );
    expect(found.results.length).toBe(1);
    expect(found.results[0]).toMatchObject({ role: "assistant" });
    expect(found.results[0]?.excerpt).toContain("fridge");
  });

  test("whole-file reads over the cap are refused with a clear message", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(97);
    const { upload } = parse(
      Upload,
      await (
        await neo.fetch(`${neo.agentUrl()}/uploads?name=big.txt`, {
          method: "POST",
          headers: { authorization: "Bearer t" },
          body: big,
        })
      ).json(),
    );
    const path = `/user/.staging/${upload.id}/big.txt`;
    await script([
      {
        tool: "edit",
        args: { path, edits: [{ oldText: "a", newText: "b" }] },
      },
      {
        tool: "bash",
        args: {
          command: `mkdir -p /n && touch /n/x.md /n/y.md && echo /n/*.md && cat ${path} | wc -c`,
        },
      },
      { text: "done" },
    ]);
    await send("try it");
    await idle(neo);
    const tools = await toolResults(neo);
    expect(tools[0]?.isError).toBe(true);
    expect(tools[0]?.output).toContain("limited to 4 MB");
    expect(tools[1]?.output).toContain("/n/x.md /n/y.md");
    expect(tools[1]?.output).toContain("over the shell's 4 MB limit");
  });
});
