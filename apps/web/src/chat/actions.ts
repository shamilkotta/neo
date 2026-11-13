export type ActionKind = "agent" | "message" | "stop" | "routine" | "memory" | "profile";

export interface Action {
  kind: ActionKind;
  text: string;
}

type Names = (id: string) => string;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function parsed(output: string) {
  try {
    return record(JSON.parse(output));
  } catch {
    return {};
  }
}

const list = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;

export function actionOf(name: string, rawArgs: unknown, output: string, names: Names): Action | null {
  const args = record(rawArgs);
  const result = parsed(output);
  switch (name) {
    case "create_agent": {
      const agent = record(result.agent);
      return { kind: "agent", text: `Created agent ${str(agent.name) ?? str(args.name) ?? ""}`.trim() };
    }
    case "send_message": {
      const to = Array.isArray(args.recipientAgentIds) ? args.recipientAgentIds.filter((i) => typeof i === "string") : [];
      const verb = args.replyToMessageId ? "Replied to" : "Messaged";
      return { kind: "message", text: `${verb} ${list(to.map(names))}` };
    }
    case "interrupt_agent":
      return { kind: "stop", text: `Stopped ${names(str(args.agentId) ?? "")}` };
    case "create_schedule": {
      const s = record(result.created);
      return { kind: "routine", text: `Scheduled “${str(s.name) ?? "routine"}”${str(s.when) ? ` · ${str(s.when)}` : ""}` };
    }
    case "update_schedule": {
      const s = record(result.updated);
      return { kind: "routine", text: `Updated routine “${str(s.name) ?? "routine"}”` };
    }
    case "delete_schedule":
      return { kind: "routine", text: "Deleted a routine" };
    case "remember":
      return { kind: "memory", text: args.memoryId ? "Updated a memory" : "Saved to memory" };
    case "forget_memory":
      return { kind: "memory", text: "Forgot a memory" };
    case "update_profile":
      return { kind: "profile", text: "Updated its profile" };
    default:
      return null;
  }
}
