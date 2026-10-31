import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import {
  INPUT_ENTRY,
  type InputEntryData,
  type Mailbox,
  type Turn,
} from "./mailbox";
import type { TranscriptItem } from "@neo/client";
export type { TranscriptItem } from "@neo/client";

const OUTPUT_LIMIT = 4_000;
const context = BACKGROUND_CONTEXT;

export async function readTranscript(
  conversation: Conversation,
  mailbox: Mailbox,
  options: { before?: number; limit?: number } = {},
): Promise<{
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  before: number | null;
}> {
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
      const id = entry.id as unknown as number;
      if (options.before !== undefined && id >= options.before) continue;
      if (entries.length < limit) entries.push(entry);
      else {
        more = true;
        if (entry.kind === INPUT_ENTRY) {
          owner = (entry.data as InputEntryData).turnId;
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
    const entryId = entry.id as unknown as number;
    if (entry.kind === INPUT_ENTRY) {
      const data = entry.data as InputEntryData;
      if (!data.steered) turnId = data.turnId;
      items.push({
        type: "input",
        entryId,
        turnId: data.turnId,
        steered: !!data.steered,
        messages: data.messages,
      });
      continue;
    }
    const message = entry.model?.[0] as Record<string, any> | undefined;
    if (entry.kind === "pi.compaction")
      items.push({ type: "compaction", entryId, turnId });
    else if (entry.kind === "pi.reset")
      items.push({ type: "reset", entryId, turnId });
    else if (message?.role === "assistant") {
      const parts = (message.content ?? []) as Record<string, any>[];
      items.push({
        type: "assistant",
        entryId,
        turnId,
        text: parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
        thinking: parts.some((p) => p.type === "thinking"),
        toolCalls: parts
          .filter((p) => p.type === "toolCall")
          .map((p) => ({ id: p.id, name: p.name, args: p.arguments })),
        stopReason: message.stopReason ?? null,
        error: message.errorMessage ?? null,
      });
    } else if (message?.role === "toolResult") {
      const output = ((message.content ?? []) as Record<string, any>[])
        .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
        .join("");
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
        isError: !!message.isError,
        ...(message.toolName === "send_file" &&
        !message.isError &&
        message.details?.file
          ? { file: message.details.file }
          : {}),
      });
    }
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
    before:
      more && entries.length ? (entries[0]!.id as unknown as number) : null,
  };
}
