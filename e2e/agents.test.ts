import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NeoApiError, NeoClient } from "@neo/client";
import { type Instance, instance, TOKEN, until } from "./harness";

let neo: Instance;
let root: NeoClient;
beforeEach(async () => {
  neo = await instance();
  root = neo.client();
});
afterEach(async () => {
  await neo.close();
});

const answersOf = async (id: string) =>
  ((await neo.agent(id).call("GET", "/transcript")).items as any[])
    .filter((i) => i.type === "assistant" && i.text)
    .map((i) => i.text as string);
const idleAgent = (id: string) =>
  until(
    async () => {
      const s = await neo.agent(id).call("GET", "/status");
      return !s.turn && s.queued === 0 ? s : undefined;
    },
    8000,
    `${id} idle`,
  );

describe("agents", () => {
  test("a new instance has one primary agent, which cannot be deleted", async () => {
    const agents = await root.agents();
    expect(agents.map((a) => [a.id, a.name, a.primary])).toEqual([
      ["neo", "Neo", true],
    ]);
    const error = await root.deleteAgent("neo").catch((e) => e);
    expect(error).toBeInstanceOf(NeoApiError);
    expect(error.status).toBe(409);
  });

  test("the person makes agents; names are unique; an unknown agent is a 404", async () => {
    const research = await root.createAgent({
      name: "Research",
      title: "Researcher",
    });
    expect(research.id).toBe("research");
    expect(research.primary).toBe(false);
    const taken = await root.createAgent({ name: "research" }).catch((e) => e);
    expect(taken.status).toBe(409);
    expect((await root.agents()).map((a) => a.id)).toEqual(["neo", "research"]);
    const profile = await root.agent("research").profile();
    expect(profile.name).toBe("Research");
    const missing = await root
      .agent("nobody")
      .status()
      .catch((e) => e);
    expect(missing.status).toBe(404);
  });

  test("agents run their turns at the same time, each in its own world", async () => {
    await root.createAgent({ name: "Helper" });
    const a = neo.agent("neo");
    const b = neo.agent("helper");
    await a.call("POST", "/test/script", {
      steps: [{ gate: "a" }, { text: "neo done" }],
    });
    await b.call("POST", "/test/script", {
      steps: [{ gate: "b" }, { text: "helper done" }],
    });
    await a.call("POST", "/messages", { text: "job a" });
    await b.call("POST", "/messages", { text: "job b" });
    await until(
      async () =>
        (await a.call("GET", "/status")).turn &&
        (await b.call("GET", "/status")).turn,
      5000,
      "both turns",
    );
    await b.call("POST", "/test/release", { gate: "b" });
    await idleAgent("helper");
    expect((await a.call("GET", "/status")).turn).not.toBeNull();
    await a.call("POST", "/test/release", { gate: "a" });
    await idleAgent("neo");
    expect(await answersOf("neo")).toEqual(["neo done"]);
    expect(await answersOf("helper")).toEqual(["helper done"]);
    const schedules = await b.call("GET", "/schedules");
    expect(schedules.schedules.map((s: any) => s.system)).toEqual([
      "heartbeat",
    ]);
  });

  test("the profile reaches the agent's prompt; the list shows who is working", async () => {
    await root.createAgent({ name: "Scribe", instructions: "Write in haiku." });
    const scribe = neo.agent("scribe");
    await scribe.call("POST", "/test/script", {
      steps: [{ recall: "ok" }],
    });
    await scribe.call("POST", "/messages", { text: "hello" });
    await idleAgent("scribe");
    const seen = (await scribe.call("GET", "/test/seen")).seen as string[];
    expect(seen.length).toBe(1);
    await root.updateAgent("scribe", { title: "Poet" });
    expect((await scribe.call("GET", "/agent")).agent.title).toBe("Poet");

    await scribe.call("POST", "/test/script", { steps: [{ gate: "w" }] });
    await scribe.call("POST", "/messages", { text: "work" });
    await until(
      async () =>
        (await root.agents()).find((a) => a.id === "scribe")?.status?.working,
      5000,
      "a working status",
    );
    const busy = await root.deleteAgent("scribe").catch((e) => e);
    expect(busy.status).toBe(409);
    await scribe.call("POST", "/stop");
  });

  test("deleting an agent removes its chat and files", async () => {
    await root.createAgent({ name: "Temp" });
    const temp = neo.agent("temp");
    const put = await neo.fetch(`${neo.agentUrl("temp")}/uploads?name=a.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "temporary",
    });
    expect(put.ok).toBe(true);
    await temp.call("POST", "/test/script", { steps: [{ text: "hi" }] });
    await temp.call("POST", "/messages", { text: "hello" });
    await idleAgent("temp");
    await root.deleteAgent("temp");
    expect((await root.agents()).map((a) => a.id)).toEqual(["neo"]);
    const gone = await temp.call("GET", "/status").catch((e) => e);
    expect(gone.status).toBe(404);
    const again = await root.createAgent({ name: "Temp" });
    expect(again.id).toBe("temp");
    expect(
      (await temp.call("GET", "/transcript")).items as unknown[],
    ).toEqual([]);
  });
});
