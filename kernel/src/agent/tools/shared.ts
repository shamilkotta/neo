import type { Conversation } from "@earendil-works/pi-durable";
import type { History } from "../../services/history";
import type { Memories } from "../../services/memory";
import type { Settings } from "../../services/settings";
import type { Vfs } from "../../vfs/vfs";
import type { Mailbox } from "../mailbox";
import type { Schedules } from "../schedules";

/** What the agent's own tools reach. Tools find their agent from the calling conversation. */
export interface ToolServices {
  memories: Memories;
  history: History;
  mailbox: Mailbox;
  schedules: Schedules;
  /** A schedule changed: arm the alarm again and tell clients. */
  changed(agentId: string): Promise<void>;
  settings: Settings;
  /** The agent whose conversation this is. */
  agentOf(conversationId: number): Promise<string>;
  conversation(agentId: string): Promise<Conversation>;
  vfs: Vfs;
  now: () => number;
}

export const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});
export const json = (value: unknown) => text(JSON.stringify(value, null, 2));

/** A failure the model reads and can correct (OpenBot's tool failure). */
export class ToolRefusal extends Error {}
export const refuse = (message: string): never => {
  throw new ToolRefusal(message);
};

/** The calling agent and the turn the call runs in. */
export async function caller(
  services: ToolServices,
  conversationId: number,
): Promise<{ agentId: string; turnId: string | undefined }> {
  const agentId = await services.agentOf(conversationId);
  const turn = await services.mailbox.currentTurn(agentId);
  return { agentId, turnId: turn?.id };
}
