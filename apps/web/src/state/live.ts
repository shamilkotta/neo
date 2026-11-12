import type { LiveEvent } from "@neo/client";
import { Type } from "typebox";
import Value from "typebox/value";

export interface LiveTool {
  id: string;
  name: string;
  output: string;
}

export interface LiveTurn {
  active: boolean;
  text: string;
  tools: LiveTool[];
}

export const IDLE: LiveTurn = { active: false, text: "", tools: [] };

export function applyLive(
  current: LiveTurn,
  event: LiveEvent,
  settle: () => void,
): LiveTurn {
  if (!Value.Check(PiEvent, event.data)) return current;
  const e = event.data;
  switch (e.type) {
    case "run_start":
      return { active: true, text: "", tools: [] };
    case "message_start":
      return e.message.role === "assistant"
        ? { ...current, active: true, text: "" }
        : current;
    case "message_update": {
      let text = current.text;
      for (const c of e.changes)
        if (c.type === "text_delta" && c.delta !== undefined) text += c.delta;
      return text === current.text ? current : { ...current, active: true, text };
    }
    case "message_end":
      settle();
      return { ...current, text: "" };
    case "tool_execution_start":
      return {
        ...current,
        active: true,
        tools: [
          ...current.tools,
          { id: e.toolCallId, name: e.toolName, output: "" },
        ],
      };
    case "tool_execution_update":
      return {
        ...current,
        tools: current.tools.map((t) =>
          t.id !== e.toolCallId
            ? t
            : {
                ...t,
                output:
                  e.output && "set" in e.output
                    ? e.output.set
                    : (t.output + (e.output?.append ?? "")).slice(-4000),
              },
        ),
      };
    case "tool_execution_end":
      settle();
      return {
        ...current,
        tools: current.tools.filter((t) => t.id !== e.toolCallId),
      };
    case "run_end":
      settle();
      return IDLE;
    default: {
      const unhandled: never = e;
      return unhandled;
    }
  }
}

const toolEvent = <const T extends string>(type: T) =>
  Type.Object({
    type: Type.Literal(type),
    toolCallId: Type.String(),
    toolName: Type.String(),
  });

const PiEvent = Type.Union([
  Type.Object({ type: Type.Literal("run_start") }),
  Type.Object({ type: Type.Literal("run_end") }),
  Type.Object({
    type: Type.Literal("message_start"),
    message: Type.Object({ role: Type.String() }),
  }),
  Type.Object({
    type: Type.Literal("message_update"),
    changes: Type.Array(
      Type.Object({
        type: Type.String(),
        delta: Type.Optional(Type.String()),
      }),
    ),
  }),
  Type.Object({ type: Type.Literal("message_end") }),
  toolEvent("tool_execution_start"),
  Type.Intersect([
    toolEvent("tool_execution_update"),
    Type.Object({
      output: Type.Optional(
        Type.Union([
          Type.Object({ set: Type.String() }),
          Type.Object({ append: Type.Optional(Type.String()) }),
        ]),
      ),
    }),
  ]),
  toolEvent("tool_execution_end"),
]);
