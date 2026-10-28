import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answers, idle, type Instance, instance, running, transcript, until } from "./harness";

let neo: Instance;
beforeEach(async () => {
  neo = await instance();
});
afterEach(async () => {
  await neo.close();
});

const script = (steps: unknown[], append = false) => neo.call("POST", "/v1/test/script", { steps, append });
const send = (text: string, extra: Record<string, unknown> = {}) =>
  neo.call("POST", "/v1/messages", { text, ...extra }).then((r) => r.message);

describe("turns", () => {
  test("a message runs one turn: tool steps, answer, transcript", async () => {
    await script([{ step: 1 }, { text: "hello back" }]);
    await send("hi");
    await idle(neo);
    const items = await transcript(neo);
    expect(items.map((i) => i.type)).toEqual(["input", "assistant", "tool", "assistant"]);
    expect(items[0].messages[0].text).toBe("hi");
    expect(items[2].output).toBe("step 1 ok");
    expect(items[3].text).toBe("hello back");
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
    const { seen } = await neo.call("GET", "/v1/test/seen");
    expect(seen.at(-1)).toContain("[Message from the person ·");
    expect(seen.at(-1)).toContain("what time is it");
  });
});

describe("queue", () => {
  test("messages sent while a turn runs wait, then start one turn together", async () => {
    await script([{ gate: "g" }, { text: "first done" }, { recall: "both read" }]);
    await send("first");
    await running(neo);
    await send("second");
    await send("third");
    expect((await neo.call("GET", "/v1/queue")).queue.map((m: any) => m.text)).toEqual(["second", "third"]);
    await neo.call("POST", "/v1/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual(["first done", "both read"]);
    const { seen } = await neo.call("GET", "/v1/test/seen");
    expect(seen.at(-1)).toContain("This turn starts with 2 messages");
    const inputs = (await transcript(neo)).filter((i) => i.type === "input");
    expect(inputs.map((i) => i.messages.map((m: any) => m.text))).toEqual([["first"], ["second", "third"]]);
  });

  test("queued messages can be edited, reordered and cancelled before they run", async () => {
    await script([{ gate: "g" }, { text: "first done" }, { recall: "rest" }]);
    await send("first");
    await running(neo);
    const a = await send("a");
    const b = await send("b");
    const c = await send("c");
    await neo.call("PATCH", `/v1/queue/${a.id}`, { text: "a (edited)" });
    await neo.call("PUT", "/v1/queue/order", { order: [c.id, a.id] });
    await neo.call("DELETE", `/v1/queue/${b.id}`);
    expect((await neo.call("GET", "/v1/queue")).queue.map((m: any) => m.text)).toEqual(["c", "a (edited)"]);
    await neo.call("POST", "/v1/test/release", { gate: "g" });
    await idle(neo);
    const last = (await transcript(neo)).filter((i) => i.type === "input").at(-1);
    expect(last.messages.map((m: any) => m.text)).toEqual(["c", "a (edited)"]);
    await expect(neo.call("PATCH", `/v1/queue/${a.id}`, { text: "too late" })).rejects.toThrow();
  });

  test("a message can join the running turn (steer)", async () => {
    await script([{ gate: "g" }, { recall: "saw it" }]);
    await send("start work");
    await running(neo);
    const steered = await send("also do X", { steer: true });
    await neo.call("POST", "/v1/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual(["saw it"]);
    const { seen } = await neo.call("GET", "/v1/test/seen");
    expect(seen.at(-1)).toContain("also do X");
    expect(seen.at(-1)).toContain("arrived while you were working");
    const turn = (await neo.call("GET", `/v1/turns/${(await neo.call("GET", "/v1/transcript")).items[0].turnId}`));
    expect(turn.messages.map((m: any) => [m.text, m.status])).toEqual([
      ["start work", "completed"],
      ["also do X", "completed"],
    ]);
    expect(turn.messages[1].id).toBe(steered.id);
  });

  test("stop interrupts the turn; the queue moves on", async () => {
    await script([{ gate: "never" }, { text: "next turn ran" }]);
    await send("long job");
    await running(neo);
    await send("after");
    expect((await neo.call("POST", "/v1/stop")).stopped).toBe(true);
    await idle(neo);
    const inputs = (await transcript(neo)).filter((i) => i.type === "input");
    const { turns } = await neo.call("GET", "/v1/transcript");
    expect(turns[inputs[0].turnId].status).toBe("interrupted");
    expect(turns[inputs[1].turnId].status).toBe("completed");
    expect(await answers(neo)).toEqual(["next turn ran"]);
  });

  test("pause holds the queue; resume drains it", async () => {
    await script([{ text: "ran after resume" }]);
    await neo.call("POST", "/v1/pause");
    await send("while paused");
    await Bun.sleep(150);
    expect((await neo.call("GET", "/v1/status")).queued).toBe(1);
    await neo.call("POST", "/v1/resume");
    await idle(neo);
    expect(await answers(neo)).toEqual(["ran after resume"]);
  });
});

describe("memory", () => {
  test("memories an agent saves commit when its turn completes, and are in the next prompt", async () => {
    await script([
      { tool: "remember", args: { text: "The person's dog is called Biscuit", inclusion: "essential" } },
      { text: "noted" },
      { recall: "ok" },
    ]);
    await send("my dog is Biscuit");
    await idle(neo);
    const { memories } = await neo.call("GET", "/v1/memories");
    expect(memories.map((m: any) => [m.text, m.kind, m.origin])).toEqual([
      ["The person's dog is called Biscuit", "essential", "automatic"],
    ]);
    await send("hello again");
    await idle(neo);
    const { seen } = await neo.call("GET", "/v1/test/seen");
    expect(seen.at(-1)).toContain("Biscuit");
  });

  test("memories staged in an interrupted turn are dropped", async () => {
    await script([
      { tool: "remember", args: { text: "should not be kept" } },
      { gate: "never" },
    ]);
    await send("remember something then hang");
    await until(async () => (await transcript(neo)).some((i) => i.type === "tool" && i.name === "remember"), 5000, "remember ran");
    await neo.call("POST", "/v1/stop");
    await idle(neo);
    expect((await neo.call("GET", "/v1/memories")).memories).toEqual([]);
  });

  test("the person's memories apply at once and can be searched", async () => {
    await neo.call("POST", "/v1/memories", { text: "Prefers short answers", kind: "essential" });
    await neo.call("POST", "/v1/memories", { text: "Works at a bakery in Kochi" });
    const found = await neo.call("GET", "/v1/memories?q=bakery");
    expect(found.memories.map((m: any) => m.text)).toEqual(["Works at a bakery in Kochi"]);
  });
});

describe("time", () => {
  test("a wake-up the agent schedules comes back as a message and runs a turn", async () => {
    await script([
      { tool: "schedule_wakeup", args: { note: "check the oven", inMinutes: 0.005 } },
      { text: "will check" },
      { recall: "checked the oven" },
    ]);
    await send("remind yourself to check the oven");
    await idle(neo);
    const pending = (await neo.call("GET", "/v1/wakeups")).wakeups;
    expect(pending.map((w: any) => [w.note, w.createdBy])).toEqual([["check the oven", "agent"]]);
    await Bun.sleep(400);
    await neo.call("POST", "/v1/test/wake");
    await idle(neo);
    expect(await answers(neo)).toEqual(["will check", "checked the oven"]);
    const last = (await transcript(neo)).filter((i) => i.type === "input").at(-1);
    expect(last.messages[0]).toMatchObject({ source: "wakeup", text: "check the oven" });
    expect((await neo.call("GET", "/v1/wakeups")).wakeups).toEqual([]);
  });

  test("the alarm fires a due wake-up by itself", async () => {
    await script([{ text: "woke up" }]);
    await neo.call("POST", "/v1/wakeups", { note: "ping", inMinutes: 0.01 });
    await until(async () => (await answers(neo)).includes("woke up") || undefined, 8000, "the wake-up turn");
  });

  test("a heartbeat with nothing to say is quiet; one with news shows", async () => {
    await neo.call("PATCH", "/v1/agent", { heartbeat: { enabled: true, everyMinutes: 30 } });
    await script([{ text: "HEARTBEAT_OK" }]);
    await neo.call("POST", "/v1/test/heartbeat-due");
    await neo.call("POST", "/v1/test/wake");
    await idle(neo);
    expect(await transcript(neo)).toEqual([]);
    await script([{ text: "Your 3pm meeting moved" }]);
    await neo.call("POST", "/v1/test/heartbeat-due");
    await neo.call("POST", "/v1/test/wake");
    await idle(neo);
    expect(await answers(neo)).toEqual(["Your 3pm meeting moved"]);
    const agent = (await neo.call("GET", "/v1/agent")).agent;
    expect(agent.heartbeatNextAt).toBeGreaterThan(Date.now() + 25 * 60_000);
  });
});

describe("files", () => {
  test("the shell works on the workspace", async () => {
    await script([
      { tool: "bash", args: { command: "mkdir -p /notes && echo 'buy milk' > /notes/todo.txt && wc -l /notes/todo.txt" } },
      { text: "saved" },
    ]);
    await send("note: buy milk");
    await idle(neo);
    const tool = (await transcript(neo)).find((i) => i.type === "tool");
    expect(tool.output).toContain("1 /notes/todo.txt");
    const listing = await neo.call("GET", "/v1/files?path=/notes");
    expect(listing.entries.map((e: any) => e.name)).toEqual(["todo.txt"]);
  });
});

describe("recovery", () => {
  test("a turn cut off mid-tool resumes after a restart", async () => {
    if (!neo.restart) return; // Bun only: a Durable Object restart is not ours to cause
    await script([{ gate: "g" }, { text: "unused" }]);
    await send("long job");
    await until(async () => (await transcript(neo)).some((i) => i.type === "assistant"), 5000, "the tool call");
    await send("queued behind it");
    await neo.restart();
    // The new process has a new scripted model: the gate tool replays (replay-safe), then answers.
    await script([{ text: "resumed after restart" }, { text: "then the queue" }]);
    await neo.call("POST", "/v1/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual(["resumed after restart", "then the queue"]);
    const { turns } = await neo.call("GET", "/v1/transcript");
    expect(Object.values(turns).map((t: any) => t.status)).toEqual(["completed", "completed"]);
  });
});

describe("client", () => {
  test("NeoClient follows the event stream", async () => {
    const { NeoClient } = await import("@neo/client");
    const status = await neo.call("GET", "/v1/status");
    const client = new NeoClient({ url: neo.url(), token: "t" });
    const seen: string[] = [];
    const stop = client.events({ durable: (e) => seen.push(e.type), live: (e) => seen.push(`live:${(e.data as any).type}`) }, status.latestEvent);
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
    const size = 3 * 1024 * 1024 + 123; // past the inline limit: one blob object
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
    const put = await fetch(`${neo.url()}/v1/files?path=/big/data.bin`, {
      method: "PUT",
      headers: { authorization: "Bearer t" },
      body: bytes,
    });
    expect(await put.json()).toEqual({ written: "/big/data.bin", size });
    const got = new Uint8Array(await (await fetch(`${neo.url()}/v1/files?path=/big/data.bin`, { headers: { authorization: "Bearer t" } })).arrayBuffer());
    expect(got.length).toBe(size);
    expect(Bun.hash(got)).toBe(Bun.hash(bytes));
  });
});

describe("bounded memory", () => {
  test("history search finds old messages through the index", async () => {
    await script([{ text: "Noted: the wifi password is on the fridge" }, { text: "ok" }]);
    await send("where did I leave the wifi password?");
    await idle(neo);
    await send("something else");
    await idle(neo);
    await script([{ tool: "history_search", args: { query: "wif fridg" } }, { text: "found" }]);
    await send("search history");
    await idle(neo);
    const tool = (await transcript(neo)).find((i) => i.type === "tool" && i.name === "history_search");
    const found = JSON.parse(tool.output);
    expect(found.results.length).toBe(1);
    expect(found.results[0]).toMatchObject({ role: "assistant" });
    expect(found.results[0].excerpt).toContain("fridge");
  });

  test("whole-file reads over the cap are refused with a clear message", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(97);
    await fetch(`${neo.url()}/v1/files?path=/big.txt`, { method: "PUT", headers: { authorization: "Bearer t" }, body: big });
    await script([
      { tool: "edit", args: { path: "/big.txt", edits: [{ oldText: "a", newText: "b" }] } },
      { tool: "bash", args: { command: "mkdir -p /n && touch /n/x.md /n/y.md && echo /n/*.md && cat /big.txt | wc -c" } },
      { text: "done" },
    ]);
    await send("try it");
    await idle(neo);
    const tools = (await transcript(neo)).filter((i) => i.type === "tool");
    expect(tools[0].isError).toBe(true);
    expect(tools[0].output).toContain("limited to 4 MB");
    expect(tools[1].output).toContain("/n/x.md /n/y.md");
    expect(tools[1].output).toContain("over the shell's 4 MB limit");
  });
});
