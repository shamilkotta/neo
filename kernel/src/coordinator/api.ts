import type { NewAgent, ProfileChange, SettingsShape } from "@neo/client";
import {
  body,
  eventStream,
  HttpError,
  json,
  matcher,
  serve,
} from "../http";
import { NEO_VERSION } from "../neo";
import {
  detectLocalProviders,
  type ProviderConfig,
} from "../services/providers";
import type { NeoCoordinator } from "./coordinator";

/** The instance's API: agents, settings, providers, moves. Agent routes go to each agent's home. */
export function handleCoordinatorApi(
  neo: NeoCoordinator,
  request: Request,
): Promise<Response> {
  return serve(request, async (request, url) => {
    await neo.finishDeletes();
    return route(neo, request, url);
  });
}

async function route(
  neo: NeoCoordinator,
  request: Request,
  url: URL,
): Promise<Response> {
  const { is, match } = matcher(request, url);
  let m: RegExpExecArray | null;

  if (is("GET", "/status")) {
    const status: Record<string, unknown> = {
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
    const { passphrase } = await body<{ passphrase?: string }>(request);
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

  if (is("GET", "/agents"))
    return json({ agents: await live.registry.list() });
  if (is("POST", "/agents")) {
    const agent = await neo.createAgent(await body<NewAgent>(request));
    return json({ agent }, 201);
  }
  if ((m = match("GET", /^\/agents\/([\w-]+)$/))) {
    const agent = await live.registry.get(m[1]!);
    if (!agent) throw new HttpError(404, "No such agent");
    return json({ agent });
  }
  if ((m = match("PATCH", /^\/agents\/([\w-]+)$/)))
    return json({
      agent: await neo.updateAgent(m[1]!, await body<ProfileChange>(request)),
    });
  if ((m = match("DELETE", /^\/agents\/([\w-]+)$/))) {
    await neo.deleteAgent(m[1]!);
    return json({ deleted: m[1] });
  }

  if (is("GET", "/settings"))
    return json({ settings: await live.settings.all() });
  if (is("PUT", "/settings"))
    return json({
      settings: await neo.updateSettings(
        await body<Partial<SettingsShape>>(request),
      ),
    });

  if (is("GET", "/providers"))
    return json({ providers: await live.providers.list() });
  if (is("GET", "/providers/detect"))
    return json({
      found: neo.host.capabilities.sockets ? await detectLocalProviders() : [],
    });
  if ((m = match("PUT", /^\/providers\/([\w-]+)$/))) {
    const config = await body<ProviderConfig>(request);
    await neo.putProvider({ ...config, id: m[1]! });
    return json({ providers: await live.providers.list() });
  }
  if ((m = match("DELETE", /^\/providers\/([\w-]+)$/))) {
    await neo.removeProvider(m[1]!);
    return json({ providers: await live.providers.list() });
  }
  if (is("GET", "/models"))
    return json({
      models: await neo.catalog.available(),
      default: (await neo.model()) ?? null,
    });

  throw new HttpError(404, "Not found");
}
