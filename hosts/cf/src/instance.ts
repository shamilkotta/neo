import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { AgentCreator, SharedRequest } from "@neo/kernel";
import { ClientSignal, SOCKET_PROTOCOL } from "@neo/client";
import { Value } from "typebox/value";
import type {
  AgentId,
  AgentStatus,
  AgentTopic,
  NewAgent,
  ProfileChange,
} from "@neo/client";
import { CloudflareHost, socketState, type SocketState } from "./host";

export class InstanceDO extends DurableObject<Env> {
  private readonly host: CloudflareHost;
  private readonly ready: Promise<void>;
  private readonly routes = new Hono<{ Bindings: { instance: string } }>()
    .get("/connect", (c) => this.accept(c.req.raw, c.env.instance))
    .all("*", (c) => this.host.fetch(c.req.raw, c.env.instance));

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new CloudflareHost(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.host.open();
    });
  }

  override async fetch(request: Request) {
    await this.ready;
    const instance = request.headers.get("x-neo-instance");
    if (!instance)
      return Response.json({ error: "No instance" }, { status: 404 });
    return this.routes.fetch(request, { instance });
  }

  private accept(request: Request, instance: string) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return Response.json({ error: "Expected a WebSocket" }, { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const socket: SocketState = { instance, watching: null };
    server.serializeAttachment(socket);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": SOCKET_PROTOCOL },
    });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ) {
    await this.ready;
    if (typeof message !== "string") return;
    let signal: unknown;
    try {
      signal = JSON.parse(message);
    } catch {
      return;
    }
    if (!Value.Check(ClientSignal, signal)) return;
    const socket = socketState(ws);
    ws.serializeAttachment({ ...socket, watching: signal.agentId });
    await (
      await this.host.named(socket.instance)
    ).watchChanged(socket.watching, signal.agentId);
  }

  override async webSocketClose(ws: WebSocket) {
    await this.release(ws);
  }

  override async webSocketError(ws: WebSocket) {
    await this.release(ws);
  }

  private async release(ws: WebSocket) {
    await this.ready;
    const socket = socketState(ws);
    ws.serializeAttachment({ ...socket, watching: null });
    await (
      await this.host.named(socket.instance)
    ).watchChanged(socket.watching, null);
  }

  async agentInit(instance: string, agentId: AgentId) {
    await this.ready;
    return (await this.host.named(instance)).agentInit(agentId);
  }

  async agentConfig(instance: string) {
    await this.ready;
    return (await this.host.named(instance)).agentConfig();
  }

  async agentChanged(
    instance: string,
    agentId: AgentId,
    topics: AgentTopic[],
    status: AgentStatus | undefined,
  ) {
    await this.ready;
    return (await this.host.named(instance)).agentChanged(
      agentId,
      topics,
      status,
    );
  }

  async agentLive(instance: string, agentId: AgentId, events: unknown[]) {
    await this.ready;
    (await this.host.named(instance)).agentLive(agentId, events);
  }

  async agentList(instance: string) {
    await this.ready;
    return (await this.host.named(instance)).services().registry.list();
  }

  async agentCreate(instance: string, input: NewAgent, creator: AgentCreator) {
    await this.ready;
    return (await this.host.named(instance)).createAgent(input, creator);
  }

  async agentUpdate(instance: string, agentId: AgentId, change: ProfileChange) {
    await this.ready;
    return (await this.host.named(instance)).updateAgent(agentId, change);
  }

  async sharedCall(instance: string, request: SharedRequest) {
    await this.ready;
    return (await this.host.named(instance)).sharedCall(request);
  }

  async sharedStream(instance: string, path: string) {
    await this.ready;
    return (await this.host.named(instance)).sharedStream(path);
  }
}
