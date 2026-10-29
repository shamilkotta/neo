import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { caller, json, refuse, type ToolServices } from "./shared";

const READ_CHARS = 8_000;
const PAGE = 20;
const STEPS = 20;

/** Searching and reading the conversation's whole history, through its index (`services/history.ts`). */
export function historyTools(services: ToolServices) {
  /** The index catches up with the transcript before each use. */
  const ready = async (conversationId: number) => {
    const c = await caller(services, conversationId);
    await services.history.sync(
      c.agentId,
      await services.conversation(c.agentId),
    );
    return c;
  };
  return [
    defineTool({
      name: "history_search",
      description:
        "Search your whole conversation history with the person, including messages from before a compaction that you no longer see. Every term must appear (words match by prefix, case-insensitive). Returns excerpts, newest first, and a cursor; use history_read for the full text.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        before: Type.Optional(
          Type.Number({ description: "A cursor from an earlier result" }),
        ),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await ready(api.conversationId);
        const results = await services.history.search(c.agentId, args.query, {
          ...(args.before !== undefined ? { before: args.before } : {}),
          limit: args.limit ?? 8,
        });
        return json({
          results,
          nextCursor: results.length ? results.at(-1)!.messageId : null,
        });
      },
    }),
    defineTool({
      name: "history_read",
      description:
        "Read your conversation history. Give messageId (with offset for long text) to read one message, or before (a cursor) for older messages; nothing for the newest. Captured work steps list the tools called, never raw reasoning; continue them with workStepsOffset.",
      parameters: Type.Object({
        messageId: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        before: Type.Optional(Type.Number()),
        workStepsOffset: Type.Optional(Type.Number({ minimum: 0 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await ready(api.conversationId);
        if (args.messageId !== undefined) {
          const line = await services.history.message(
            c.agentId,
            args.messageId,
          );
          if (!line) refuse("No such message.");
          const offset = args.offset ?? 0;
          const stepsFrom = args.workStepsOffset ?? 0;
          return json({
            messageId: line!.messageId,
            role: line!.role,
            text: line!.text.slice(offset, offset + READ_CHARS),
            offset,
            nextOffset:
              offset + READ_CHARS < line!.text.length
                ? offset + READ_CHARS
                : null,
            workSteps: line!.steps.slice(stepsFrom, stepsFrom + STEPS),
            nextWorkStepsOffset:
              stepsFrom + STEPS < line!.steps.length ? stepsFrom + STEPS : null,
          });
        }
        const page = await services.history.page(c.agentId, args.before, PAGE);
        return json({
          messages: page.lines.map((l) => ({
            messageId: l.messageId,
            role: l.role,
            text: l.text.length > 1_500 ? `${l.text.slice(0, 1_500)}…` : l.text,
            truncated: l.text.length > 1_500,
            workSteps: l.steps.length,
          })),
          before: page.before,
        });
      },
    }),
  ];
}
