import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { MEMORY_LIMIT, type Memory } from "../../services/memory";
import { caller, json, refuse, type ToolServices } from "./shared";

const inclusion = Type.Union([
  Type.Literal("essential"),
  Type.Literal("searchable"),
]);

const view = (m: Memory) => ({
  memoryId: m.id,
  text: m.text,
  inclusion: m.kind,
  origin: m.origin,
  userControlled: m.userControlled,
  revision: m.revision,
  updatedAt: new Date(m.updatedAt).toISOString(),
});

/** OpenBot's memory tools: changes are staged and kept only when the turn completes. */
export function memoryTools(services: ToolServices) {
  const turn = async (conversationId: number) => {
    const c = await caller(services, conversationId);
    if (!c.turnId)
      refuse("Memories change only in a turn that answers a message.");
    return c as typeof c & { turnId: string };
  };
  return [
    defineTool({
      name: "remember",
      description:
        "Stage one short, durable memory for yourself. Use memoryId to correct or consolidate an existing memory. New entries are searchable unless inclusion is essential (in every prompt, within a budget); essential requests that do not fit stay searchable. The change commits only if the current turn completes.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 500 }),
        memoryId: Type.Optional(Type.String()),
        inclusion: Type.Optional(inclusion),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await turn(api.conversationId);
        return json(
          await services.memories.stageRemember(
            c.agentId,
            c.turnId,
            api.callId,
            {
              text: args.text,
              ...(args.memoryId ? { memoryId: args.memoryId } : {}),
              ...(args.inclusion ? { inclusion: args.inclusion } : {}),
            },
          ),
        );
      },
    }),
    defineTool({
      name: "forget_memory",
      description:
        "Stage deletion of one saved memory when the person asks you to forget it, or or when it is stale, wrong, no longer useful, or merged into another. Prune freely; do not wait for the limit. The change commits only if the current turn completes.",
      parameters: Type.Object({ memoryId: Type.String({ minLength: 1 }) }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await turn(api.conversationId);
        return json(
          await services.memories.stageForget(
            c.agentId,
            c.turnId,
            api.callId,
            args.memoryId,
          ),
        );
      },
    }),
    defineTool({
      name: "search_memories",
      description:
        "Search your saved memories when a past preference, decision or fact can help with the task. Returns committed entries and their selection revisions. Terms are literal words. No match means the fact was not found; do not invent it.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const found = await services.memories.search(
          c.agentId,
          args.query,
          args.limit ?? 5,
        );
        return json({ memories: found.map(view), count: found.length });
      },
    }),
    defineTool({
      name: "list_memories",
      description:
        "Read a page of your saved memories for review or maintenance. Pass nextCursor as after to continue. Search is usually better for a specific fact.",
      parameters: Type.Object({
        after: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const page = await services.memories.page(
          c.agentId,
          args.after ?? null,
        );
        return json({
          memories: page.memories.map(view),
          nextCursor: page.nextCursor,
          total: await services.memories.count(c.agentId),
          limit: MEMORY_LIMIT,
        });
      },
    }),
    defineTool({
      name: "set_memory_inclusion",
      description:
        "Stage which memories are in every prompt. Use essential only for facts needed across tasks, searchable for the rest. Give each memory's current revision (from search_memories or list_memories). Changes commit together after a successful turn, within the prompt budget. The person's own choices cannot be changed. This never deletes memory text.",
      parameters: Type.Object({
        changes: Type.Array(
          Type.Object({
            memoryId: Type.String(),
            inclusion,
            expectedRevision: Type.Number({ minimum: 0 }),
          }),
          { minItems: 1, maxItems: 25 },
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await turn(api.conversationId);
        return json(
          await services.memories.stageSelection(
            c.agentId,
            c.turnId,
            api.callId,
            args.changes,
          ),
        );
      },
    }),
  ];
}
