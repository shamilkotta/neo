import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { formatTime } from "../mailbox";
import { type Wakeup, WakeupError, wakeupTime } from "../wakeups";
import { caller, json, refuse, type ToolServices } from "./shared";

/** How the agent follows up on its own: a time, and a note it gets back as a message then. */
export function wakeupTools(services: ToolServices) {
  const view = async (w: Wakeup) => ({
    wakeupId: w.id,
    at: formatTime(w.at, await services.settings.get("timezone")),
    atIso: new Date(w.at).toISOString(),
    note: w.note,
    status: w.status,
  });
  return [
    defineTool({
      name: "schedule_wakeup",
      description:
        "Wake yourself up later with a note to yourself: you get the note back as a message at that time, even if nobody writes to you. Use it to follow up, check on something, or remind the person. Give at as the person's local time (2026-10-29T09:00), or an ISO time with an offset, or inMinutes. Write the note so that you will understand it without this conversation's context.",
      parameters: Type.Object({
        note: Type.String({ minLength: 1, maxLength: 2000 }),
        at: Type.Optional(Type.String()),
        inMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const timezone = await services.settings.get("timezone");
        try {
          const at = wakeupTime(args, api.now(), timezone);
          // The tool task's id: a call replayed after a restart schedules the same wake-up once.
          const wakeup = await services.wakeups.add(c.agentId, at, args.note, "agent", `tool:${api.taskId}`);
          return json({ scheduled: await view(wakeup) });
        } catch (error) {
          if (error instanceof WakeupError) refuse(error.message);
          throw error;
        }
      },
    }),
    defineTool({
      name: "list_wakeups",
      description: "List your pending wake-ups, soonest first.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const c = await caller(services, api.conversationId);
        const pending = await services.wakeups.list(c.agentId);
        return json({ wakeups: await Promise.all(pending.map(view)) });
      },
    }),
    defineTool({
      name: "cancel_wakeup",
      description: "Cancel one pending wake-up that is no longer needed.",
      parameters: Type.Object({ wakeupId: Type.String({ minLength: 1 }) }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const cancelled = await services.wakeups.cancel(c.agentId, args.wakeupId);
        if (!cancelled) refuse("No pending wake-up has that id.");
        return json({ cancelled: args.wakeupId });
      },
    }),
  ];
}
