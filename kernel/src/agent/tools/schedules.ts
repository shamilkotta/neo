import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { formatTime } from "../mailbox";
import {
  describeSpec,
  type Schedule,
  ScheduleError,
  type ScheduleInput,
} from "../schedules";
import { caller, json, refuse, type ToolServices } from "./shared";

const Window = Type.Object({
  start: Type.String({ description: "HH:MM local" }),
  end: Type.String({
    description: "HH:MM local; earlier than start spans midnight",
  }),
});

/** The fields a schedule is written with, shared by create and update. */
const Prompt = Type.String({
  minLength: 1,
  maxLength: 4000,
  description:
    "What you get as a message each time. Write it so you understand it without this conversation.",
});
const fields = {
  name: Type.Optional(
    Type.String({ maxLength: 80, description: "A short label." }),
  ),
  prompt: Type.Optional(Prompt),
  at: Type.Optional(
    Type.String({
      description:
        "Once, at the person's local time (2026-10-29T09:00) or an ISO time with an offset.",
    }),
  ),
  inMinutes: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: "Once, this many minutes from now.",
    }),
  ),
  everyMinutes: Type.Optional(
    Type.Integer({ minimum: 5, description: "Repeat at this interval." }),
  ),
  cron: Type.Optional(
    Type.String({
      description:
        'Repeat on a five-field cron in local time, e.g. "0 9 * * 1" (Mondays 09:00).',
    }),
  ),
  window: Type.Optional(
    Type.Union([Window, Type.Null()], {
      description: "Only fire inside these local hours.",
    }),
  ),
  whenBusy: Type.Optional(
    Type.Union([Type.Literal("queue"), Type.Literal("skip")], {
      description:
        "If you are busy then: queue (default; runs after) or skip this time.",
    }),
  ),
  missed: Type.Optional(
    Type.Union([Type.Literal("run"), Type.Literal("skip")], {
      description:
        "If the host was down at the time: run once late (default) or skip to the next time.",
    }),
  ),
  quiet: Type.Optional(
    Type.Boolean({
      description:
        "You may answer exactly QUIET_OK when there is nothing to report; the turn is hidden.",
    }),
  ),
  enabled: Type.Optional(Type.Boolean()),
  maxRuns: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  ),
  endsAt: Type.Optional(
    Type.Union([
      Type.String({
        description: "Stop after this time (same formats as at).",
      }),
      Type.Null(),
    ]),
  ),
};

/**
 * How the agent acts on its own time: one-off reminders, repeating routines and its heartbeat are
 * all schedules, created and changed with the same tools.
 */
export function scheduleTools(services: ToolServices) {
  const view = async (s: Schedule) => {
    const timezone = s.timezone ?? (await services.settings.get("timezone"));
    return {
      scheduleId: s.id,
      name: s.name,
      when: describeSpec(s.spec, timezone),
      ...(s.window ? { window: s.window } : {}),
      next: s.nextAt === null ? null : formatTime(s.nextAt, timezone),
      enabled: s.enabled,
      ...(s.system ? { builtIn: s.system } : {}),
      whenBusy: s.whenBusy,
      missed: s.missed,
      quiet: s.quiet,
      runs: s.runCount,
      ...(s.maxRuns !== null ? { maxRuns: s.maxRuns } : {}),
      prompt: s.prompt,
    };
  };
  const attempt = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ScheduleError) refuse(error.message);
      throw error;
    }
  };
  return [
    defineTool({
      name: "create_schedule",
      description:
        "Schedule yourself: you get the prompt back as a message at that time, even if nobody writes to you. Use it for reminders and follow-ups (at or inMinutes: once) and for anything regular (everyMinutes or cron: repeating), instead of relying on the person to remind you.",
      parameters: Type.Object({ ...fields, prompt: Prompt }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const timezone = await services.settings.get("timezone");
        // The tool task's id: a call replayed after a restart creates one schedule.
        const schedule = await attempt(() =>
          services.schedules.create(
            c.agentId,
            args as ScheduleInput,
            "agent",
            timezone,
            { originKey: `tool:${api.taskId}` },
          ),
        );
        await services.changed(c.agentId);
        return json({ created: await view(schedule) });
      },
    }),
    defineTool({
      name: "list_schedules",
      description:
        "List your schedules (reminders, routines, the heartbeat): what each does and when it fires next.",
      parameters: Type.Object({
        all: Type.Optional(
          Type.Boolean({
            description: "Include finished and turned-off ones.",
          }),
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const list = await services.schedules.list(
          c.agentId,
          args.all ? "all" : "active",
        );
        return json({ schedules: await Promise.all(list.map(view)) });
      },
    }),
    defineTool({
      name: "update_schedule",
      description:
        "Change a schedule: its timing, prompt, window or settings, or turn it off and on (enabled). This is also how you change your heartbeat.",
      parameters: Type.Object({
        scheduleId: Type.String({ minLength: 1 }),
        ...fields,
      }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const { scheduleId, ...change } = args;
        const timezone = await services.settings.get("timezone");
        const schedule = await attempt(() =>
          services.schedules.update(
            c.agentId,
            scheduleId,
            change as ScheduleInput,
            timezone,
          ),
        );
        if (!schedule) refuse("No schedule has that id.");
        await services.changed(c.agentId);
        return json({ updated: await view(schedule!) });
      },
    }),
    defineTool({
      name: "delete_schedule",
      description: "Delete a schedule that is no longer needed.",
      parameters: Type.Object({ scheduleId: Type.String({ minLength: 1 }) }),
      replay: "safe",
      execute: async (args, api) => {
        const c = await caller(services, api.conversationId);
        const removed = await attempt(() =>
          services.schedules.remove(c.agentId, args.scheduleId),
        );
        // A replay after a crash finds it gone already: that is still a success.
        if (!removed)
          return json({ deleted: args.scheduleId, note: "it was not there" });
        await services.changed(c.agentId);
        return json({ deleted: args.scheduleId });
      },
    }),
  ];
}
