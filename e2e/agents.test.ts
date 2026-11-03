import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NeoApiError, NeoClient, agentId } from "@neo/client";
import {
  failure,
  type Instance,
  instance,
  TOKEN,
  until,
  AgentState,
  answers,
  transcript,
  Seen,
  Schedules,
} from "./harness";

let neo: Instance;
let root: NeoClient;
beforeEach(async () => {
  neo = await instance();
  root = neo.client();
});
afterEach(async () => {
  await neo.close();
});

const answersOf = (id: string) => answers(neo.agent(id));
const idleAgent = (id: string) =>
  until(
    async () => {
      const s = await neo.agent(id).call("GET", "/status", AgentState);
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
    const error = await failure(root.deleteAgent(agentId("neo")));
    expect(error).toBeInstanceOf(NeoApiError);
    expect(error.status).toBe(409);
  });

  test("the person makes agents; names are unique; an unknown agent is a 404", async () => {
    const research = await root.createAgent({
      name: "Research",
      title: "Researcher",
    });
    expect<string>(research.id).toBe("research");
    expect(research.primary).toBe(false);
    const taken = await failure(root.createAgent({ name: "research" }));
    expect(taken.status).toBe(409);
    expect<string[]>((await root.agents()).map((a) => a.id)).toEqual([
      "neo",
      "research",
    ]);
    const profile = await root.agent(agentId("research")).profile();
    expect(profile.name).toBe("Research");
    const missing = await failure(root.agent(agentId("nobody")).status());
    expect(missing.status).toBe(404);
  });

  test("agents run their turns at the same time, each in its own world", async () => {
    await root.createAgent({ name: "Helper" });
    const a = neo.agent(agentId("neo"));
    const b = neo.agent(agentId("helper"));
    await a.act("POST", "/test/script", {
      steps: [{ gate: "a" }, { text: "neo done" }],
    });
    await b.act("POST", "/test/script", {
      steps: [{ gate: "b" }, { text: "helper done" }],
    });
    await a.act("POST", "/messages", { text: "job a" });
    await b.act("POST", "/messages", { text: "job b" });
    await until(
      async () =>
        (await a.call("GET", "/status", AgentState)).turn &&
        (await b.call("GET", "/status", AgentState)).turn,
      5000,
      "both turns",
    );
    await b.act("POST", "/test/release", { gate: "b" });
    await idleAgent("helper");
    expect((await a.call("GET", "/status", AgentState)).turn).not.toBeNull();
    await a.act("POST", "/test/release", { gate: "a" });
    await idleAgent("neo");
    expect(await answersOf("neo")).toEqual(["neo done"]);
    expect(await answersOf("helper")).toEqual(["helper done"]);
    const schedules = await b.call("GET", "/schedules", Schedules);
    expect(schedules.schedules.map((s) => s.system)).toEqual(["heartbeat"]);
  });

  test("the profile reaches the agent's prompt; the list shows who is working", async () => {
    await root.createAgent({ name: "Scribe", instructions: "Write in haiku." });
    const scribe = neo.agent(agentId("scribe"));
    await scribe.act("POST", "/test/script", {
      steps: [{ recall: "ok" }],
    });
    await scribe.act("POST", "/messages", { text: "hello" });
    await idleAgent("scribe");
    const seen = (await scribe.call("GET", "/test/seen", Seen)).seen;
    expect(seen.length).toBe(1);
    await root.updateAgent(agentId("scribe"), { title: "Poet" });
    expect((await root.agent(agentId("scribe")).profile()).title).toBe("Poet");

    await scribe.act("POST", "/test/script", { steps: [{ gate: "w" }] });
    await scribe.act("POST", "/messages", { text: "work" });
    await until(
      async () =>
        (await root.agents()).find((a) => a.id === "scribe")?.status?.working,
      5000,
      "a working status",
    );
    const busy = await failure(root.deleteAgent(agentId("scribe")));
    expect(busy.status).toBe(409);
    await scribe.act("POST", "/stop");
  });

  test("deleting an agent removes its chat and files", async () => {
    await root.createAgent({ name: "Temp" });
    const temp = neo.agent(agentId("temp"));
    const put = await neo.fetch(`${neo.agentUrl("temp")}/uploads?name=a.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "temporary",
    });
    expect(put.ok).toBe(true);
    await temp.act("POST", "/test/script", { steps: [{ text: "hi" }] });
    await temp.act("POST", "/messages", { text: "hello" });
    await idleAgent("temp");
    await root.deleteAgent(agentId("temp"));
    expect<string[]>((await root.agents()).map((a) => a.id)).toEqual(["neo"]);
    const gone = await failure(temp.call("GET", "/status", AgentState));
    expect(gone.status).toBe(404);
    const again = await root.createAgent({ name: "Temp" });
    expect<string>(again.id).toBe("temp");
    expect(await transcript(temp)).toEqual([]);
  });
});
