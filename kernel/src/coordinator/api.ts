import {
  isAgentId,
  NewAgent,
  ProfileChange,
  JsonObject,
  ProviderConfig,
  SettingsChange,
  type AgentId,
  type Status,
} from "@neo/client";
import { Type } from "typebox";
import {
  body,
  eventStream,
  HttpError,
  json,
  matcher,
  serve,
  valid,
} from "../http";
import { NEO_VERSION } from "../neo";
import { detectLocalProviders } from "../services/providers";
import type { NeoCoordinator } from "./coordinator";

export function handleCoordinatorApi(neo: NeoCoordinator, request: Request) {
  return serve(request, async (request, url) => {
    await neo.finishDeletes();
    return route(neo, request, url);
  });
}

async function route(neo: NeoCoordinator, request: Request, url: URL) {
  const { is, param } = matcher(request, url);
  let id: string | undefined;
  const agentParam = (method: string) => {
    const raw = param(method, /^\/agents\/([\w-]+)$/);
    if (raw !== undefined && !isAgentId(raw))
      throw new HttpError(404, "No such agent");
    return raw;
  };
  let agentId: AgentId | undefined;

  if (is("GET", "/status")) {
    const status: Status = {
      version: NEO_VERSION,
      host: neo.host.name,
      state: neo.state,
      instanceId: neo.instanceId,
      epoch: await neo.epoch(),
      capabilities: neo.host.capabilities,
      test: !!neo.host.test,
      latestEvent: await neo.events.latest(),
    };
    if (neo.state === "active") {
      status.model = (await neo.model()) ?? null;
      status.agents = await neo.services().registry.list();
    }
    return json(status);
  }
  if (is("GET", "/events")) return eventStream(neo.events, request, url);

  if (is("POST", "/move/seal")) {
    await neo.seal();
    return json({ state: neo.state });
  }
  if (is("POST", "/move/unseal")) {
    await neo.unseal();
    return json({ state: neo.state });
  }
  if (is("POST", "/move/export")) {
    const { passphrase } = await body(
      request,
      Type.Object({ passphrase: Type.Optional(Type.String()) }),
    );
    return new Response(await neo.exportBundle(passphrase || undefined), {
      headers: {
        "content-type": "application/x-neo-bundle",
        "cache-control": "no-store",
      },
    });
  }
  if (is("POST", "/move/import")) {
    if (!request.body)
      throw new HttpError(400, "The bundle is the request body");
    return json(
      await neo.importBundle(
        request.body,
        request.headers.get("x-neo-passphrase") || undefined,
      ),
    );
  }
  if (is("POST", "/move/complete")) {
    await neo.markMoved();
    return json({ state: neo.state });
  }

  const live = neo.services();

  if (is("GET", "/agents")) return json({ agents: await live.registry.list() });
  if (is("POST", "/agents")) {
    const agent = await neo.createAgent(await body(request, NewAgent));
    return json({ agent }, 201);
  }
  if ((agentId = agentParam("GET")) !== undefined) {
    const agent = await live.registry.get(agentId);
    if (!agent) throw new HttpError(404, "No such agent");
    return json({ agent });
  }
  if ((agentId = agentParam("PATCH")) !== undefined)
    return json({
      agent: await neo.updateAgent(agentId, await body(request, ProfileChange)),
    });
  if ((agentId = agentParam("DELETE")) !== undefined) {
    await neo.deleteAgent(agentId);
    return json({ deleted: agentId });
  }

  if (is("GET", "/settings"))
    return json({ settings: await live.settings.all() });
  if (is("PUT", "/settings"))
    return json({
      settings: await neo.updateSettings(await body(request, SettingsChange)),
    });

  if (is("GET", "/providers"))
    return json({ providers: await live.providers.list() });
  if (is("GET", "/providers/detect"))
    return json({
      found: neo.host.capabilities.sockets ? await detectLocalProviders() : [],
    });
  if ((id = param("PUT", /^\/providers\/([\w-]+)$/)) !== undefined) {
    const config = valid(ProviderConfig, {
      ...(await body(request, JsonObject)),
      id,
    });
    await neo.putProvider(config);
    return json({ providers: await live.providers.list() });
  }
  if ((id = param("DELETE", /^\/providers\/([\w-]+)$/)) !== undefined) {
    await neo.removeProvider(id);
    return json({ providers: await live.providers.list() });
  }
  if (is("GET", "/models"))
    return json({
      models: await neo.catalog.available(),
      default: (await neo.model()) ?? null,
    });

  throw new HttpError(404, "Not found");
}
