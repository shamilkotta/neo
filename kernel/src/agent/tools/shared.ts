import type { Conversation } from "@earendil-works/pi-durable";
import type { History } from "../../services/history";
import type { Memories } from "../../services/memory";
import type { Vfs } from "../../vfs/vfs";
import type { Mailbox } from "../mailbox";
import type { Schedules } from "../schedules";

export interface ToolServices {
  memories: Memories;
  history: History;
  mailbox: Mailbox;
  schedules: Schedules;
  changed(): Promise<void>;
  timezone(): Promise<string>;
  conversation(): Promise<Conversation>;
  vfs: Vfs;
  now: () => number;
}

export const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});
export const json = (value: unknown) => text(JSON.stringify(value, null, 2));

export class ToolRefusal extends Error {}
export function refuse(message: string): never {
  throw new ToolRefusal(message);
}

export async function turnId(services: ToolServices) {
  const turn = await services.mailbox.currentTurn();
  return turn
    ? turn.id
    : refuse("Memories change only in a turn that answers a message.");
}
