import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentProfile, parseJson, type NeoClient, agentId } from "@neo/client";
import type { ScriptStep } from "@neo/kernel/testing";
import { Type } from "typebox";
import {
  AgentState,
  inputs as inputsOf,
  type Instance,
  instance,
  Queue,
  seen as seenBy,
  toolResults,
  until,
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

const at = (id: string) => neo.agent(id);
const Profile = Type.Object({ agent: AgentProfile });
const script = (id: string, steps: ScriptStep[], append = false) =>
  at(id).act("POST", "/test/script", { steps, append });
const idle = (id: string) =>
  until(
    async () => {
      const s = await at(id).call("GET", "/status", AgentState);
      return !s.turn && s.queued === 0 ? s : undefined;
    },
    8000,
    `${id} idle`,
  );
const inputs = (id: string) => inputsOf(at(id));
const fromTeammates = async (id: string) =>
  (await inputs(id)).filter((m) => m.source === "agent");
const toolOutputs = (id: string) => toolResults(at(id));
const seen = async (id: string) => (await seenBy(at(id))).join("\n");

describe("messages between agents", () => {
  test("a request and its reply; the reply is framed as one", async () => {
    await root.createAgent({ name: "Helper" });
    await at("helper").act("POST", "/pause");
    await script("neo", [
      {
        tool: "send_message",
        args: { recipientAgentIds: ["helper"], text: "find x" },
      },
      { text: "asked helper" },
    ]);
    await at("neo").act("POST", "/messages", { text: "ask helper" });
    await idle("neo");
    const [queued] = (await at("helper").call("GET", "/queue", Queue)).queue;
    if (queued?.source !== "agent" || queued.meta.kind !== "message")
      throw new Error("Expected a message from a teammate");
    expect(queued.text).toBe("find x");
    expect(queued.meta.from).toEqual({ id: agentId("neo"), name: "Neo" });
    expect(queued.meta.expectsReply).toBe(true);
    const id = queued.meta.messageId;

    await script("helper", [
      {
        tool: "send_message",
        args: {
          recipientAgentIds: ["neo"],
          replyToMessageId: id,
          expectsReply: false,
          text: "Status: done\nResult: x = 1",
        },
      },
      { recall: "replied" },
    ]);
    await script("neo", [{ recall: "x is 1" }]);
    await at("helper").act("POST", "/resume");
    await until(
      async () => (await fromTeammates("neo")).length === 1,
      8000,
      "the reply",
    );
    await idle("neo");
    await idle("helper");
    expect((await fromTeammates("neo"))[0]?.text).toContain("Result: x = 1");
    expect(await seen("helper")).toContain("is waiting for your answer");
    expect(await seen("neo")).toContain(`A reply to your message ${id}`);
    expect((await fromTeammates("neo")).length).toBe(1);
  });

  test("a teammate that ends its turn without replying sends 'No answer'", async () => {
    await root.createAgent({ name: "Quiet" });
    await script("neo", [
      {
        tool: "send_message",
        args: { recipientAgentIds: ["quiet"], text: "hello?" },
      },
      { text: "sent" },
      { recall: "noted" },
    ]);
    await at("neo").act("POST", "/messages", { text: "ask quiet" });
    await until(
      async () => (await fromTeammates("neo")).length === 1,
      8000,
      "no answer",
    );
    await idle("neo");
    expect((await fromTeammates("neo"))[0]?.text).toContain("did not answer");
    expect(await seen("neo")).toContain(
      "No answer from teammate Quiet (quiet)",
    );
  });

  test("answers from several teammates arrive together", async () => {
    await root.createAgent({ name: "A" });
    await root.createAgent({ name: "B" });
    await script("neo", [
      {
        tool: "send_message",
        args: { recipientAgentIds: ["a", "b"], text: "both of you" },
      },
      { text: "asked both" },
      { recall: "got both" },
    ]);
    await at("neo").act("POST", "/messages", { text: "ask both" });
    await until(
      async () => (await fromTeammates("neo")).length >= 1,
      8000,
      "the group",
    );
    await idle("neo");
    const got = await fromTeammates("neo");
    expect(got.length).toBe(1);
    expect(got[0]?.text).toContain("From A (a)");
    expect(got[0]?.text).toContain("From B (b)");
    expect(await seen("neo")).toContain("Replies from 2 teammates");
  });

  test("unknown teammates and yourself are refused; list_agents shows the team", async () => {
    await root.createAgent({ name: "Helper", title: "Helps" });
    await script("neo", [
      {
        tool: "send_message",
        args: { recipientAgentIds: ["nobody"], text: "hi" },
      },
      {
        tool: "send_message",
        args: { recipientAgentIds: ["neo"], text: "hi" },
      },
      { tool: "list_agents", args: {} },
      { text: "done" },
    ]);
    await at("neo").act("POST", "/messages", { text: "try" });
    await idle("neo");
    const [unknown, self, list] = await toolOutputs("neo");
    expect(unknown?.isError).toBe(true);
    expect(unknown?.output).toContain("No agent nobody");
    expect(self?.isError).toBe(true);
    const team = parseJson(
      Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          you: Type.Optional(Type.Boolean()),
        }),
      ),
      list?.output ?? "",
    );
    expect(team.map((a) => [a.id, a.title ?? null, !!a.you])).toEqual([
      ["neo", null, true],
      ["helper", "Helps", false],
    ]);
  });
});

describe("team tools", () => {
  test("create_agent makes a teammate that starts on its first message", async () => {
    await script("neo", [
      {
        tool: "create_agent",
        args: {
          name: "Writer",
          title: "Writes things",
          instructions: "Be brief.",
          initialMessage: "write a line",
        },
      },
      { text: "made writer" },
    ]);
    await at("neo").act("POST", "/messages", { text: "make a writer" });
    await idle("neo");
    const agents = await root.agents();
    const writer = agents.find((a) => a.id === "writer");
    expect(writer?.createdBy).toBe("neo");
    expect(writer?.instructions).toBe("Be brief.");
    await until(
      async () =>
        (await inputs("writer")).some((m) => m.text === "write a line"),
      8000,
      "the first message",
    );
  });

  test("update_profile changes only the agent's own profile", async () => {
    await script("neo", [
      { tool: "update_profile", args: { title: "Chief of staff" } },
      { text: "ok" },
    ]);
    await at("neo").act("POST", "/messages", {
      text: "you are my chief of staff",
    });
    await idle("neo");
    expect((await root.agents())[0]?.title).toBe("Chief of staff");
    expect((await at("neo").call("GET", "/agent", Profile)).agent.title).toBe(
      "Chief of staff",
    );
  });

  test("interrupt_agent stops work done for you, and no 'No answer' comes back", async () => {
    await root.createAgent({ name: "Slow" });
    await script("slow", [{ gate: "never" }]);
    await script("neo", [
      {
        tool: "send_message",
        args: { recipientAgentIds: ["slow"], text: "long job" },
      },
      { text: "sent" },
    ]);
    await at("neo").act("POST", "/messages", { text: "start" });
    await idle("neo");
    await until(
      async () => (await at("slow").call("GET", "/status", AgentState)).turn,
      5000,
      "slow working",
    );
    await script("neo", [
      { tool: "interrupt_agent", args: { agentId: "slow" } },
      { text: "stopped it" },
    ]);
    await at("neo").act("POST", "/messages", { text: "stop slow" });
    await idle("neo");
    await idle("slow");
    const outputs = await toolOutputs("neo");
    expect(JSON.parse(outputs.at(-1)?.output ?? "")).toEqual({
      stopped: true,
      cancelled: 0,
    });
    await Bun.sleep(300);
    expect(await fromTeammates("neo")).toEqual([]);
  });
});
