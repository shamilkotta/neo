import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type EntryRecord } from "@earendil-works/pi-durable";
import { INPUT_ENTRY, type InputEntryData } from "../mailbox";
import { caller, json, refuse, type ToolServices } from "./shared";

const EXCERPT = 400;
const READ_CHARS = 8_000;
const PAGE = 20;
const SCAN = 10_000;

interface Line {
  messageId: number;
  role: "user" | "assistant";
  text: string;
  steps: string[];
}

export function lineOf(entry: EntryRecord): Line | undefined {
  // A turn's input: the messages as they were sent, not the combined prompt.
  if (entry.kind === INPUT_ENTRY) {
    const data = entry.data as InputEntryData | undefined;
    const text = (data?.messages ?? []).map((m) => m.text).join("\n\n");
    if (!text.trim()) return undefined;
    return { messageId: entry.id as unknown as number, role: "user", text, steps: [] };
  }
  const message = entry.model?.[0] as
    { role?: string; content?: unknown } | undefined;
  if (!message || (message.role !== "user" && message.role !== "assistant"))
    return undefined;
  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : ((message.content as {
          type: string;
          text?: string;
          name?: string;
          arguments?: unknown;
        }[]) ?? []);
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  // Work steps: the tools called, never raw reasoning.
  const steps = parts
    .filter((p) => p.type === "toolCall")
    .map(
      (p) => `${p.name}(${JSON.stringify(p.arguments ?? {}).slice(0, 200)})`,
    );
  if (!text.trim() && steps.length === 0) return undefined;
  return {
    messageId: entry.id as unknown as number,
    role: message.role,
    text,
    steps,
  };
}

/**
 * The conversation's messages, oldest first, across resets and compactions: the model may no
 * longer see older ones, but they stay in storage, and this is how the agent finds them again.
 */
async function messages(services: ToolServices, agentId: string): Promise<Line[]> {
  const conversation = await services.conversation(agentId);
  const lines: Line[] = [];
  let cursor: Parameters<typeof conversation.entries>[2];
  for (let scanned = 0; scanned < SCAN; ) {
    const page = await conversation.entries({ order: "descending" }, 500, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      const line = lineOf(entry);
      if (line) lines.push(line);
    }
    scanned += page.items.length;
    if (!page.next || page.items.length === 0) break;
    cursor = page.next;
  }
  return lines.reverse();
}

export function historyTools(services: ToolServices) {
  return [
    defineTool({
      name: "history_search",
      description:
        "Search your whole conversation history with the person, including messages from before a compaction that you no longer see. Every term must appear (literal words, case-insensitive). Returns bounded excerpts and a cursor; use history_read for the full text.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        before: Type.Optional(
          Type.Number({ description: "A cursor from an earlier result" }),
        ),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const all = await messages(services, c.agentId);
        const hits = all
          .filter((l) => args.before === undefined || l.messageId < args.before)
          .filter((l) => terms.every((t) => l.text.toLowerCase().includes(t)))
          .reverse()
          .slice(0, args.limit ?? 8);
        return json({
          results: hits.map((l) => {
            const at = l.text.toLowerCase().indexOf(terms[0]!);
            const from = Math.max(0, at - EXCERPT / 2);
            return {
              messageId: l.messageId,
              role: l.role,
              excerpt: `${from > 0 ? "…" : ""}${l.text.slice(from, from + EXCERPT)}${from + EXCERPT < l.text.length ? "…" : ""}`,
              length: l.text.length,
            };
          }),
          nextCursor: hits.length ? hits.at(-1)!.messageId : null,
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
        const c = await caller(services, api.conversationId);
        const all = await messages(services, c.agentId);
        if (args.messageId !== undefined) {
          const line = all.find((l) => l.messageId === args.messageId);
          if (!line) refuse("No such message.");
          const offset = args.offset ?? 0;
          const steps = line!.steps.slice(
            args.workStepsOffset ?? 0,
            (args.workStepsOffset ?? 0) + 20,
          );
          return json({
            messageId: line!.messageId,
            role: line!.role,
            text: line!.text.slice(offset, offset + READ_CHARS),
            offset,
            nextOffset:
              offset + READ_CHARS < line!.text.length
                ? offset + READ_CHARS
                : null,
            workSteps: steps,
            nextWorkStepsOffset:
              (args.workStepsOffset ?? 0) + 20 < line!.steps.length
                ? (args.workStepsOffset ?? 0) + 20
                : null,
          });
        }
        const older = all.filter(
          (l) => args.before === undefined || l.messageId < args.before,
        );
        const page = older.slice(-PAGE);
        return json({
          messages: page.map((l) => ({
            messageId: l.messageId,
            role: l.role,
            text: l.text.length > 1_500 ? `${l.text.slice(0, 1_500)}…` : l.text,
            truncated: l.text.length > 1_500,
            workSteps: l.steps.length,
          })),
          before: older.length > PAGE ? page[0]!.messageId : null,
        });
      },
    }),
  ];
}
