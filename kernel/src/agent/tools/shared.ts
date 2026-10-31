import type { Conversation } from "@earendil-works/pi-durable";
import type { History } from "../../services/history";
import type { Memories } from "../../services/memory";
import type { Settings } from "../../services/settings";
import type { Vfs } from "../../vfs/vfs";
import type { Mailbox } from "../mailbox";
import type { Schedules } from "../schedules";

export interface ToolServices {
  memories: Memories;
  history: History;
  mailbox: Mailbox;
  schedules: Schedules;
  changed(agentId: string): Promise<void>;
  settings: Settings;
  agentOf(conversationId: number): Promise<string>;
  conversation(agentId: string): Promise<Conversation>;
  vfs: Vfs;
  now: () => number;
}

export const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});
export const json = (value: unknown) => text(JSON.stringify(value, null, 2));

export class ToolRefusal extends Error {}
export const refuse = (message: string): never => {
  throw new ToolRefusal(message);
};

export async function caller(
  services: ToolServices,
  conversationId: number,
): Promise<{ agentId: string; turnId: string | undefined }> {
  const agentId = await services.agentOf(conversationId);
  const turn = await services.mailbox.currentTurn(agentId);
  return { agentId, turnId: turn?.id };
}
