import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { ASK_TOOL, askDetails } from "./tools/ask";
import { INPUT_ENTRY, InputEntryData, type Mailbox } from "./mailbox";
import { Attachment, parse, type TranscriptItem } from "@neo/client";
import { Type } from "typebox";
import Value from "typebox/value";
export type { TranscriptItem } from "@neo/client";

const OUTPUT_LIMIT = 4_000;
const context = BACKGROUND_CONTEXT;

export async function readTranscript(
  conversation: Conversation,
  mailbox: Mailbox,
  options: { before?: number; limit?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const entries: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  let more = false;
  let owner: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const page = await conversation.entries(
      { order: "descending" },
      200,
      cursor,
      context,
    );
    for (const entry of page.items) {
      if (options.before !== undefined && entry.id >= options.before) continue;
      if (entries.length < limit) entries.push(entry);
      else {
        more = true;
        if (entry.kind === INPUT_ENTRY) {
          owner = parse(InputEntryData, entry.data).turnId;
          break;
        }
      }
    }
    if (owner || !page.next || page.items.length === 0) break;
    if (more && pages > 2) break;
    cursor = page.next;
  }
  entries.reverse();
  const items: TranscriptItem[] = [];
  let turnId = owner;
  for (const entry of entries) {
    const entryId: number = entry.id;
    if (entry.kind === INPUT_ENTRY) {
      const data = parse(InputEntryData, entry.data);
      if (!data.steered) turnId = data.turnId;
      items.push({
        type: "input",
        entryId,
        turnId: data.turnId,
        steered: data.steered,
        messages: data.messages,
      });
      continue;
    }
    const message = entry.model?.[0];
    if (entry.kind === "pi.compaction")
      items.push({ type: "compaction", entryId, turnId });
    else if (entry.kind === "pi.reset")
      items.push({ type: "reset", entryId, turnId });
    else if (message?.role === "assistant") {
      const parts = message.content;
      items.push({
        type: "assistant",
        entryId,
        turnId,
        text: parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
        thinking: parts.some((p) => p.type === "thinking"),
        toolCalls: parts.flatMap((p) =>
          p.type === "toolCall"
            ? [{ id: p.id, name: p.name, args: p.arguments }]
            : [],
        ),
        stopReason: message.stopReason ?? null,
        error: message.errorMessage ?? null,
      });
    } else if (message?.role === "toolResult") {
      const output = message.content
        .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
        .join("");
      const file =
        message.toolName === "send_file" && !message.isError
          ? sentFile(message.details)
          : undefined;
      const ask =
        message.toolName === ASK_TOOL && !message.isError
          ? askDetails(message.details)
          : undefined;
      items.push({
        type: "tool",
        entryId,
        turnId,
        toolCallId: message.toolCallId,
        name: message.toolName,
        output:
          output.length > OUTPUT_LIMIT
            ? `${output.slice(0, OUTPUT_LIMIT)}…`
            : output,
        isError: message.isError,
        ...(file ? { file } : {}),
        ...(ask ? { ask: { ...ask, answer: null } } : {}),
      });
    }
  }
  const answers = await mailbox.answers(
    items.flatMap((i) =>
      i.type === "tool" && i.ask ? [i.ask.questionId] : [],
    ),
  );
  for (const item of items) {
    if (item.type !== "tool" || !item.ask) continue;
    const answer = answers.get(item.ask.questionId);
    if (answer?.source === "user" && answer.meta)
      item.ask.answer = {
        messageId: answer.id,
        answers: answer.meta.answer.answers,
        at: answer.createdAt,
      };
  }
  const ids = [
    ...new Set(items.map((i) => i.turnId).filter((t): t is string => !!t)),
  ];
  const turns = await mailbox.turnStates(ids);
  const quiet = new Set(
    [...turns.values()].filter((t) => t.quiet).map((t) => t.id),
  );
  return {
    items: items.filter((i) => !i.turnId || !quiet.has(i.turnId)),
    turns: Object.fromEntries(turns),
    before: more ? (entries[0]?.id ?? null) : null,
  };
}

const SentFile = Type.Object({
  file: Type.Intersect([
    Attachment,
    Type.Object({ caption: Type.Union([Type.String(), Type.Null()]) }),
  ]),
});

function sentFile(details: unknown) {
  return Value.Check(SentFile, details) ? details.file : undefined;
}

export async function findQuestion(
  conversation: Conversation,
  questionId: string,
) {
  let cursor: Parameters<Conversation["entries"]>[2];
  for (;;) {
    const page = await conversation.entries(
      { order: "descending" },
      200,
      cursor,
      context,
    );
    for (const entry of page.items) {
      const message = entry.model?.[0];
      if (message?.role !== "toolResult" || message.toolName !== ASK_TOOL)
        continue;
      const ask = askDetails(message.details);
      if (ask?.questionId === questionId) return ask;
    }
    if (!page.next || page.items.length === 0) return undefined;
    cursor = page.next;
  }
}
