import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentId, type AgentClient } from "@neo/client";
import type { ScriptStep } from "@neo/kernel/testing";
import {
  failure,
  idle,
  type Instance,
  instance,
  itemsOf,
  toolResults,
} from "./harness";

let neo: Instance;
let client: AgentClient;
beforeEach(async () => {
  neo = await instance();
  client = neo.client().agent(agentId("neo"));
});
afterEach(async () => {
  await neo.close();
});

const script = (steps: ScriptStep[]) =>
  neo.act("POST", "/test/script", { steps });

const QUESTIONS: { id: string; question: string; options?: { label: string }[] }[] = [
  {
    id: "env",
    question: "Which environment?",
    options: [{ label: "staging" }, { label: "production" }],
  },
  { id: "note", question: "Anything to tell the team?" },
];

async function ask() {
  await script([
    { tool: "ask_user", args: { questions: QUESTIONS } },
    { text: "Asked." },
  ]);
  await client.send("deploy it");
  await idle(neo);
  const [tool] = (await toolResults(neo)).filter((t) => t.name === "ask_user");
  if (!tool?.ask) throw new Error("Expected an ask_user card");
  return tool.ask;
}

describe("ask_user", () => {
  test("returns at once and shows an open card", async () => {
    const card = await ask();
    expect(card.questionId).toMatch(/^q_/);
    expect(card.questions).toEqual(QUESTIONS);
    expect(card.answer).toBeNull();
    expect((await client.status()).turn).toBeFalsy();
  });

  test("the answer starts a turn and locks the card", async () => {
    const card = await ask();
    await client.send("something else first");
    await idle(neo);
    const message = await client.answer({
      questionId: card.questionId,
      answers: { env: "staging", note: " ship it " },
    });
    expect(message.source).toBe("user");
    expect(message.text).toBe(
      `Answer to your question ${card.questionId}:\nQ: Which environment?\nA: staging\nQ: Anything to tell the team?\nA: ship it`,
    );
    await idle(neo);
    const [tool] = (await toolResults(neo)).filter(
      (t) => t.name === "ask_user",
    );
    expect(tool?.ask?.answer).toMatchObject({
      messageId: message.id,
      answers: { env: "staging", note: "ship it" },
    });
    const inputs = await itemsOf(neo, "input");
    expect(inputs.at(-1)?.messages[0]?.answer).toEqual({
      questionId: card.questionId,
      answers: { env: "staging", note: "ship it" },
    });
    const again = await failure(
      client.answer({ questionId: card.questionId, answers: { env: "x" } }),
    );
    expect(again.status).toBe(400);
    expect(again.message).toContain("already answered");
  });

  test("rejects unknown questions, items and empty answers", async () => {
    const card = await ask();
    expect(
      (
        await failure(
          client.answer({ questionId: "q_nope", answers: { a: "b" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await failure(
          client.answer({ questionId: card.questionId, answers: { x: "y" } }),
        )
      ).message,
    ).toContain('"x"');
    expect(
      (
        await failure(
          client.answer({ questionId: card.questionId, answers: { env: " " } }),
        )
      ).message,
    ).toContain("empty");
  });
});
