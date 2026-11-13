import type { Attachment, InputMessage, TranscriptItem, Turn } from "@neo/client";
import { type Action, actionOf } from "./actions";
import type { Ask } from "./Question";

type ToolItem = TranscriptItem & { type: "tool" };

export type Segment =
  | { kind: "text"; key: string; text: string }
  | { kind: "action"; key: string; action: Action }
  | { kind: "ask"; key: string; ask: Ask }
  | { kind: "file"; key: string; file: Attachment & { caption: string | null } }
  | { kind: "error"; key: string; text: string };

export type Block =
  | { kind: "day"; key: string; at: number }
  | { kind: "input"; key: string; message: InputMessage; steered: boolean; turn?: Turn }
  | { kind: "reply"; key: string; turnId: string | null; segments: Segment[] }
  | { kind: "note"; key: string; text: string };

export function toBlocks(
  items: TranscriptItem[],
  turns: Record<string, Turn>,
  names: (id: string) => string,
): Block[] {
  const results = new Map<string, ToolItem>();
  for (const i of items) if (i.type === "tool") results.set(i.toolCallId, i);
  const blocks: Block[] = [];
  let reply: (Block & { kind: "reply" }) | null = null;
  let lastDay = "";

  const push = (s: Segment) => reply?.segments.push(s);

  for (const item of items) {
    if (item.type === "input") {
      reply = null;
      const turn = turns[item.turnId];
      for (const m of item.messages) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) {
          lastDay = day;
          blocks.push({ kind: "day", key: `day-${m.id}`, at: m.at });
        }
        blocks.push({ kind: "input", key: m.id, message: m, steered: item.steered, turn });
      }
      continue;
    }
    if (item.type === "assistant") {
      if (!item.text && item.toolCalls.length === 0 && !item.error) continue;
      if (!reply || reply.turnId !== item.turnId) {
        reply = { kind: "reply", key: `r-${item.entryId}`, turnId: item.turnId, segments: [] };
        blocks.push(reply);
      }
      if (item.text) push({ kind: "text", key: `t-${item.entryId}`, text: item.text });
      for (const call of item.toolCalls) {
        const result = results.get(call.id);
        if (result?.ask) push({ kind: "ask", key: call.id, ask: result.ask });
        else if (result?.file) push({ kind: "file", key: call.id, file: result.file });
        else if (result && !result.isError) {
          const action = actionOf(call.name, call.args, result.output, names);
          if (action) push({ kind: "action", key: call.id, action });
        }
      }
      if (item.error && item.stopReason !== "aborted")
        push({ kind: "error", key: `e-${item.entryId}`, text: item.error });
      continue;
    }
    if (item.type === "compaction") {
      reply = null;
      blocks.push({ kind: "note", key: `n-${item.entryId}`, text: "Earlier conversation summarized" });
    } else if (item.type === "reset") {
      reply = null;
      blocks.push({ kind: "note", key: `n-${item.entryId}`, text: "New context" });
    }
  }
  return blocks;
}
