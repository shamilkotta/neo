import { authorized, preflight, unauthorized } from "@neo/kernel";
import { agentName } from "./links";

export { InstanceDO } from "./instance";
export { AgentDO } from "./agent";

/** A Worker is one instance. Tests (NEO_TEST=1) may pick a separate one per test. */
const INSTANCE = "main";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  // /i/…                the instance (coordinator)
  // /i/agents/<id>/…    one agent (its own Durable Object)
  // anything else       the web app
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const api = /^\/i(\/.*)?$/.exec(url.pathname);
    if (!api) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return preflight();
    if (!authorized(request, env.NEO_TOKEN)) return unauthorized();
    const path = api[1] ?? "/";
    const test = env.NEO_TEST === "1" && request.headers.get("x-neo-instance");
    const instance = test && NAME.test(test) ? test : INSTANCE;
    const headers = new Headers(request.headers);
    headers.set("x-neo-instance", instance);
    const forward = (inner: string) => ({
      url: new URL(inner + url.search, url.origin),
      init: {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
      },
    });
    const agent = /^\/agents\/([^/]+)(\/.+)$/.exec(path);
    if (agent) {
      const [, agentId, inner] = agent;
      if (!NAME.test(agentId!))
        return Response.json({ error: "No such agent" }, { status: 404 });
      headers.set("x-neo-agent", agentId!);
      const { url: target, init } = forward(inner!);
      return env.AGENT.getByName(agentName(instance, agentId!)).fetch(
        new Request(target, init),
      );
    }
    const { url: target, init } = forward(path);
    return env.INSTANCE.getByName(instance).fetch(new Request(target, init));
  },
} satisfies ExportedHandler<Env>;
