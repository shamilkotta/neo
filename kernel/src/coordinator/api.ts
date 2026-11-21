import {
  AgentId,
  JsonObject,
  NewAgent,
  ProfileChange,
  ProviderConfig,
  ProviderId,
  SettingsChange,
  type Status,
} from "@neo/client";
import { Type } from "typebox";
import { api, HttpError, jsonBody, pathParams, valid } from "../http";

const ByAgent = pathParams(Type.Object({ id: AgentId }));
const ByProvider = pathParams(Type.Object({ id: ProviderId }));
import { NEO_VERSION } from "../neo";
import { detectLocalProviders } from "../services/providers";
import type { NeoCoordinator } from "./coordinator";

export function coordinatorApi(neo: NeoCoordinator) {
  const app = api();
  const live = () => neo.services();
  const providers = async () => ({ providers: await live().providers.list() });

  app.use(async (_c, next) => {
    await neo.finishDeletes();
    await next();
  });

  app.get("/status", async (c) => {
    const status: Status = {
      version: NEO_VERSION,
      host: neo.host.name,
      state: neo.state,
      instanceId: neo.instanceId,
      epoch: await neo.epoch(),
      capabilities: neo.host.capabilities,
      test: !!neo.host.test,
    };
    if (neo.state === "active") {
      status.model = (await neo.model()) ?? null;
      status.agents = await live().registry.list();
    }
    return c.json(status);
  });

  app.post("/move/seal", async (c) => {
    await neo.seal();
    return c.json({ state: neo.state });
  });
  app.post("/move/unseal", async (c) => {
    await neo.unseal();
    return c.json({ state: neo.state });
  });
  app.post(
    "/move/export",
    jsonBody(Type.Object({ passphrase: Type.Optional(Type.String()) })),
    async (c) => {
      const { passphrase } = c.req.valid("json");
      return new Response(await neo.exportBundle(passphrase || undefined), {
        headers: { "content-type": "application/x-neo-bundle" },
      });
    },
  );
  app.post("/move/import", async (c) => {
    const bundle = c.req.raw.body;
    if (!bundle) throw new HttpError(400, "The bundle is the request body");
    return c.json(
      await neo.importBundle(
        bundle,
        c.req.header("x-neo-passphrase") || undefined,
      ),
    );
  });
  app.post("/move/complete", async (c) => {
    await neo.markMoved();
    return c.json({ state: neo.state });
  });

  app.get("/agents", async (c) =>
    c.json({ agents: await live().registry.list() }),
  );
  app.post("/agents", jsonBody(NewAgent), async (c) =>
    c.json({ agent: await neo.createAgent(c.req.valid("json")) }, 201),
  );
  app.get("/agents/:id", ByAgent, async (c) => {
    const agent = await live().registry.get(c.req.valid("param").id);
    if (!agent) throw new HttpError(404, "No such agent");
    return c.json({ agent });
  });
  app.patch("/agents/:id", ByAgent, jsonBody(ProfileChange), async (c) =>
    c.json({
      agent: await neo.updateAgent(
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    }),
  );
  app.delete("/agents/:id", ByAgent, async (c) => {
    const id = c.req.valid("param").id;
    await neo.deleteAgent(id);
    return c.json({ deleted: id });
  });

  app.get("/settings", async (c) =>
    c.json({ settings: await live().settings.all() }),
  );
  app.put("/settings", jsonBody(SettingsChange), async (c) =>
    c.json({ settings: await neo.updateSettings(c.req.valid("json")) }),
  );

  app.get("/providers", async (c) => c.json(await providers()));
  app.get("/providers/detect", async (c) =>
    c.json({
      found: neo.host.capabilities.sockets ? await detectLocalProviders() : [],
    }),
  );
  app.put("/providers/:id", ByProvider, jsonBody(JsonObject), async (c) => {
    await neo.putProvider(
      valid(ProviderConfig, {
        ...c.req.valid("json"),
        id: c.req.valid("param").id,
      }),
    );
    return c.json(await providers());
  });
  app.delete("/providers/:id", ByProvider, async (c) => {
    await neo.removeProvider(c.req.valid("param").id);
    return c.json(await providers());
  });

  app.get("/models", async (c) =>
    c.json({
      models: await neo.catalog.available(),
      default: (await neo.model()) ?? null,
    }),
  );

  return app;
}
