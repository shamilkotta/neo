import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import {
  type AgentId,
  type AgentProfile,
  type AgentSummary,
  isAgentId,
  type NewAgent,
  type ProfileChange,
} from "@neo/client";
import { MAX_RECIPIENTS, Messaging, MessagingError } from "../messaging";
import { json, refuse } from "./shared";

export interface TeamServices {
  me(): Promise<{ id: string; name: string }>;
  agents(): Promise<AgentSummary[]>;
  create(input: NewAgent, key: string): Promise<AgentProfile>;
  updateSelf(change: ProfileChange): Promise<AgentProfile>;
  messaging(): Messaging;
  interrupt(agentId: AgentId): Promise<{ stopped: boolean; cancelled: number }>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const state = (a: AgentSummary) =>
  !a.status
    ? "unknown"
    : a.status.paused
      ? "paused"
      : a.status.working
        ? "working"
        : a.status.queued
          ? "queued"
          : "ready";

export function teamTools(team: TeamServices) {
  const send = async (
    key: string,
    args: {
      recipientAgentIds: string[];
      text: string;
      replyToMessageId?: string;
      expectsReply?: boolean;
    },
  ) => {
    const id = Messaging.idFor(key);
    const result = await team
      .messaging()
      .send({
        id,
        to: args.recipientAgentIds,
        text: args.text,
        ...(args.replyToMessageId ? { replyTo: args.replyToMessageId } : {}),
        expectsReply: args.expectsReply ?? true,
      })
      .catch((e) =>
        refuse(e instanceof MessagingError ? e.message : errorText(e)),
      );
    if (result.delivered.length === 0)
      refuse(
        `Not delivered: ${result.failed.map((f) => `${f.id}: ${f.error}`).join("; ")}`,
      );
    return { messageId: id, ...result };
  };

  return [
    defineTool({
      name: "list_agents",
      description:
        "List your teammates: the other persistent agents working for the same person, with their id, name, role and whether they are working right now. Use it to pick who to ask with send_message.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const me = await team.me();
        return json(
          (await team.agents()).map((a) => ({
            id: a.id,
            name: a.name,
            title: a.title,
            description: a.description,
            state: state(a),
            ...(a.id === me.id ? { you: true } : {}),
          })),
        );
      },
    }),
    defineTool({
      name: "read_agent",
      description:
        "Read one teammate's profile: its role, description and standing instructions.",
      parameters: Type.Object({ agentId: Type.String() }),
      replay: "safe",
      execute: async (args) => {
        const agent = (await team.agents()).find((a) => a.id === args.agentId);
        if (!agent)
          refuse(`No teammate ${args.agentId}; list_agents shows who exists.`);
        return json({ ...agent, state: state(agent) });
      },
    }),
    defineTool({
      name: "create_agent",
      description:
        "Create a new persistent teammate. Only when the person asks for a new agent (or clearly agrees to one); never on your own. It uses the same model as every agent. Give it a clear name, role and standing instructions. With initialMessage, it gets that as a message from you and starts working at once; its answer comes back to you.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 60 }),
        title: Type.Optional(Type.String({ maxLength: 120 })),
        description: Type.Optional(Type.String({ maxLength: 1000 })),
        instructions: Type.Optional(Type.String({ maxLength: 8000 })),
        initialMessage: Type.Optional(Type.String({ maxLength: 20000 })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const agent = await team
          .create(
            {
              name: args.name,
              ...(args.title ? { title: args.title } : {}),
              ...(args.description ? { description: args.description } : {}),
              ...(args.instructions ? { instructions: args.instructions } : {}),
            },
            `create:${api.taskId}`,
          )
          .catch((e) => refuse(errorText(e)));
        const first = args.initialMessage?.trim()
          ? await send(`create:${api.taskId}`, {
              recipientAgentIds: [agent.id],
              text: args.initialMessage,
            })
          : undefined;
        return json({
          agent: { id: agent.id, name: agent.name, title: agent.title },
          ...(first ? { initialMessageId: first.messageId } : {}),
        });
      },
    }),
    defineTool({
      name: "update_profile",
      description:
        "Change your own profile: name, title, description or standing instructions. Only what the person asked for.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
        title: Type.Optional(Type.String({ maxLength: 120 })),
        description: Type.Optional(Type.String({ maxLength: 1000 })),
        instructions: Type.Optional(Type.String({ maxLength: 8000 })),
      }),
      replay: "safe",
      execute: async (args) => {
        const profile = await team
          .updateSelf(args)
          .catch((e) => refuse(errorText(e)));
        return json({
          name: profile.name,
          title: profile.title,
          description: profile.description,
          instructions: profile.instructions,
        });
      },
    }),
    defineTool({
      name: "send_message",
      description: `Send a message to one or more teammates (at most ${MAX_RECIPIENTS}); it lands in their queue like any message. By default you expect a reply: it comes back to you on its own later (replies from several teammates arrive together), so end your turn instead of waiting. Set expectsReply false for a heads-up. To answer a teammate, set replyToMessageId and expectsReply false. Files are not attached: put them in /shared and give the path.`,
      parameters: Type.Object({
        recipientAgentIds: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: MAX_RECIPIENTS,
        }),
        text: Type.String({ minLength: 1, maxLength: 20000 }),
        replyToMessageId: Type.Optional(Type.String()),
        expectsReply: Type.Optional(Type.Boolean()),
      }),
      replay: "safe",
      execute: async (args, api) =>
        json(await send(`send:${api.taskId}`, args)),
    }),
    defineTool({
      name: "interrupt_agent",
      description:
        "Stop work a teammate is doing for you: its turn stops if it is working on your message, and your messages still queued there are dropped.",
      parameters: Type.Object({ agentId: Type.String() }),
      replay: "safe",
      execute: async (args) =>
        json(
          await team
            .interrupt(
              isAgentId(args.agentId)
                ? args.agentId
                : refuse(`No teammate ${args.agentId}`),
            )
            .catch((e) => refuse(errorText(e))),
        ),
    }),
  ];
}
