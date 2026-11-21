import { AgentId, parse } from "@neo/client";
import { type Static, Type } from "typebox";
import {
  type AgentPorts,
  type Clients,
  AgentHost,
  type CoordinatorPorts,
  CoordinatorHost,
  masterKeyFromBase64,
} from "@neo/kernel";
import { createTestRuntime } from "@neo/kernel/testing";
import { CloudflareAlarm } from "./alarm";
import { CloudflareBlobs } from "./blobs";
import { agentCells, coordinatorLink } from "./links";
import { CloudflareSqlite } from "./sqlite";

const capabilities = { sockets: false, processes: false };

export const SocketState = Type.Object({
  instance: Type.String(),
  watching: Type.Union([AgentId, Type.Null()]),
});
export type SocketState = Static<typeof SocketState>;

export const socketState = (ws: WebSocket) =>
  parse(SocketState, ws.deserializeAttachment());

function socketClients(ctx: DurableObjectState): Clients {
  const watchingOf = (ws: WebSocket) => socketState(ws).watching;
  return {
    send(signal, watching) {
      const text = JSON.stringify(signal);
      for (const ws of ctx.getWebSockets()) {
        if (watching && watchingOf(ws) !== watching) continue;
        try {
          ws.send(text);
        } catch {}
      }
    },
    watching: (agentId) =>
      ctx.getWebSockets().some((ws) => watchingOf(ws) === agentId),
  };
}

export class CloudflareHost extends CoordinatorHost {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    super();
  }

  protected async ports(): Promise<CoordinatorPorts> {
    return {
      name: "cloudflare",
      db: new CloudflareSqlite(this.ctx.storage),
      blobs: new CloudflareBlobs(this.env.BLOBS, this.ctx.id.toString()),
      masterKey: await masterKeyFromBase64(this.env.NEO_MASTER_KEY),
      capabilities,
      cells: (instance) => agentCells(this.env, instance),
      clients: socketClients(this.ctx),
      ...(this.env.NEO_TEST === "1" ? { test: true } : {}),
    };
  }
}

export class CloudflareAgentHost extends AgentHost {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    super();
  }

  protected async ports(): Promise<AgentPorts> {
    return {
      name: "cloudflare",
      db: new CloudflareSqlite(this.ctx.storage),
      blobs: new CloudflareBlobs(this.env.BLOBS, this.ctx.id.toString()),
      alarm: new CloudflareAlarm(this.ctx.storage),
      capabilities,
      coordinator: (instance) => coordinatorLink(this.env, instance),
      peers: (instance) => agentCells(this.env, instance),
      ...(this.env.NEO_TEST === "1" ? { test: createTestRuntime() } : {}),
    };
  }
}
