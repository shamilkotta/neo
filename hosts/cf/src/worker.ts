import { isAgentId } from "@neo/client";
import { requireToken, withCors } from "@neo/kernel";
import { Hono, type Context } from "hono";
import { agentName } from "./links";

export { InstanceDO } from "./instance";
export { AgentDO } from "./agent";

const INSTANCE = "main";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

type Worker = { Bindings: Env; Variables: { instance: string } };

const app = new Hono<Worker>();

app.options("/i/*", withCors);
app.use(
  "/i/*",
  requireToken((c) => c.env.NEO_TOKEN),
);
app.use("/i/*", async (c, next) => {
  const test = c.env.NEO_TEST === "1" ? testInstance(c.req.raw) : undefined;
  c.set("instance", test && NAME.test(test) ? test : INSTANCE);
  await next();
});

app.all("/i/agents/:agent", (c) => toInstance(c));
app.all("/i/agents/:agent/*", async (c) => {
  const agentId = c.req.param("agent");
  if (!isAgentId(agentId)) return c.json({ error: "No such agent" }, 404);
  const instance = c.var.instance;
  const target = forward(c, `/i/agents/${agentId}`, { "x-neo-agent": agentId });
  return c.env.AGENT.getByName(agentName(instance, agentId)).fetch(target);
});
app.all("/i/*", (c) => toInstance(c));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

function toInstance(c: Context<Worker>) {
  return c.env.INSTANCE.getByName(c.var.instance).fetch(forward(c, "/i"));
}

function forward(
  c: Context<Worker>,
  prefix: string,
  extra: Record<string, string> = {},
) {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.slice(prefix.length) || "/";
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-neo-instance", c.var.instance);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Request(url, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
    signal: c.req.raw.signal,
  });
}

const testInstance = (request: Request) =>
  request.headers.get("x-neo-instance") ??
  request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith("instance."))
    ?.slice("instance.".length);
