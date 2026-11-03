import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { JsonData } from "@neo/client";
import type { Static } from "typebox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export const ScriptStep = Type.Union([
  Type.Object({ text: Type.String() }),
  Type.Object({ step: Type.Number() }),
  Type.Object({ tool: Type.String(), args: JsonData }),
  Type.Object({ gate: Type.String() }),
  Type.Object({ recall: Type.String() }),
]);
export type ScriptStep = Static<typeof ScriptStep>;

export const TEST_MODEL = { provider: "faux", modelId: "m" } as const;

export function createTestRuntime() {
  const log: string[] = [];
  const seen: string[] = [];
  const control: { block: number[] } = { block: [] };
  const gates = new Map<string, { open: boolean; waiters: (() => void)[] }>();
  const gateOf = (name: string) => {
    let g = gates.get(name);
    if (!g) gates.set(name, (g = { open: false, waiters: [] }));
    return g;
  };
  const release = (name: string) => {
    const g = gateOf(name);
    g.open = true;
    for (const w of g.waiters.splice(0)) w();
  };
  const gate = defineTool({
    name: "gate",
    description: "Wait at a named gate",
    parameters: Type.Object({ name: Type.String() }),
    replay: "safe",
    execute: async (args, _api, ctx: Context) => {
      const g = gateOf(args.name);
      if (!g.open)
        await new Promise<void>((resolve, reject) => {
          g.waiters.push(resolve);
          const signal = ctx.abortSignal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      return { output: [{ type: "text", text: `gate ${args.name} passed` }] };
    },
  });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const step = defineTool({
    name: "step",
    description: "Do one step of work",
    parameters: Type.Object({ n: Type.Number() }),
    replay: "safe",
    execute: async (args, _api, ctx: Context) => {
      log.push(`start ${args.n}`);
      if (control.block.includes(args.n)) {
        await new Promise<never>((_, reject) => {
          const signal = ctx.abortSignal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      log.push(`done ${args.n}`);
      return { output: [{ type: "text", text: `step ${args.n} ok` }] };
    },
  });
  const queues = new Map<string, ScriptStep[]>();
  const respond = (step: ScriptStep, messages: unknown[]) => {
    if ("recall" in step) {
      seen.push(JSON.stringify(messages));
      return fauxAssistantMessage([fauxText(step.recall)]);
    }
    if ("text" in step) return fauxAssistantMessage([fauxText(step.text)]);
    const call =
      "step" in step
        ? fauxToolCall("step", { n: step.step })
        : "gate" in step
          ? fauxToolCall("gate", { name: step.gate })
          : fauxToolCall(step.tool, step.args);
    return fauxAssistantMessage([call], {
      stopReason: "toolUse",
    });
  };
  const dispatch = (ctx: { messages: unknown[] }) => {
    const text = JSON.stringify(ctx.messages);
    const keys = [...queues.keys()].filter(
      (k) => k !== "*" && (queues.get(k)?.length ?? 0) > 0,
    );
    const agent =
      keys
        .filter((k) => k.startsWith("~"))
        .find((k) => text.includes(k.slice(1))) ??
      keys.find(
        (k) =>
          !k.startsWith("~") &&
          (text.includes(`You are ${k}.`) || text.includes(`You are ${k},`)),
      );
    const queue = queues.get(agent ?? "*") ?? queues.get("*");
    const step = queue?.shift();
    return step
      ? respond(step, ctx.messages)
      : fauxAssistantMessage([fauxText("(no scripted response)")]);
  };
  faux.setResponses(Array.from({ length: 100_000 }, () => dispatch));
  const script = (
    steps: ScriptStep[],
    options: { agent?: string; append?: boolean } = {},
  ) => {
    const key = options.agent ?? "*";
    queues.set(key, [
      ...(options.append ? (queues.get(key) ?? []) : []),
      ...steps,
    ]);
  };
  return {
    provider: faux.provider,
    extension: defineExtension({ name: "test", tools: [step, gate] }),
    release,
    log,
    seen,
    control,
    script,
    pending: () => [...queues.values()].reduce((n, q) => n + q.length, 0),
  };
}

export type TestRuntime = ReturnType<typeof createTestRuntime>;
