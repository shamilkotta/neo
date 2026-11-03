import { Type } from "typebox";
import {
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Credential,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createModels,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "../sql";
import type { Secrets } from "./secrets";
import {
  BuiltinKind,
  CustomModel,
  parse,
  parseJson,
  ProviderSetup,
  StringMap,
  type ProviderConfig,
  type ProviderInfo,
  type ProviderKind,
} from "@neo/client";
import Value from "typebox/value";
export type { ProviderKind, CustomModel, ProviderConfig } from "@neo/client";

export const PROVIDERS_SCHEMA = async (tx: SqliteExecutor) => {
  await tx.exec(`CREATE TABLE neo_providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    base_url TEXT,
    models TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  ) STRICT`);
};

interface ProviderRow {
  id: string;
  kind: ProviderKind;
  base_url: string | null;
  models: string;
  env: string;
  created_at: number;
}

const BUILTIN: Record<BuiltinKind, () => Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
};

const LOCAL_SERVERS = [
  {
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    list: "http://127.0.0.1:11434/api/tags",
    pick: (json: unknown) =>
      parse(
        Type.Object({
          models: Type.Array(Type.Object({ name: Type.String() })),
        }),
        json,
      ).models.map((m) => m.name),
  },
  {
    id: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    list: "http://127.0.0.1:1234/v1/models",
    pick: (json: unknown) =>
      parse(
        Type.Object({ data: Type.Array(Type.Object({ id: Type.String() })) }),
        json,
      ).data.map((m) => m.id),
  },
];

export async function detectLocalProviders(fetcher: typeof fetch = fetch) {
  const found: ProviderConfig[] = [];
  for (const server of LOCAL_SERVERS) {
    try {
      const response = await fetcher(server.list, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) continue;
      const models = server.pick(await response.json());
      if (models.length)
        found.push({
          id: server.id,
          kind: "openai-compatible",
          baseUrl: server.baseUrl,
          models: models.map((id) => ({ id })),
        });
    } catch {}
  }
  return found;
}

export const providerSecretName = (id: string) => `provider:${id}`;

export type ResolvedProvider = ProviderConfig;

export class ProviderStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly secrets: Secrets,
    private readonly now: () => number = Date.now,
  ) {}

  async resolved() {
    const out: ResolvedProvider[] = [];
    for (const row of await this.rows()) {
      const key = await this.secrets.get(providerSecretName(row.id));
      out.push({ ...toConfig(row), ...(key ? { apiKey: key } : {}) });
    }
    return out;
  }

  async list() {
    const out: ProviderInfo[] = [];
    for (const row of await this.rows()) {
      out.push({
        ...toConfig(row),
        hasKey:
          (await this.secrets.get(providerSecretName(row.id))) !== undefined,
      });
    }
    return out;
  }

  async put(config: ProviderConfig) {
    if (
      config.kind === "openai-compatible" &&
      Value.Check(BuiltinKind, config.id)
    )
      throw new Error("That id is reserved for a built-in provider");
    await this.db.run(
      `INSERT INTO neo_providers (id, kind, base_url, models, env, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, base_url = excluded.base_url, models = excluded.models, env = excluded.env`,
      config.id,
      config.kind,
      config.kind === "openai-compatible" ? config.baseUrl : null,
      JSON.stringify(config.kind === "openai-compatible" ? config.models : []),
      JSON.stringify(config.env ?? {}),
      this.now(),
    );
    if (config.apiKey !== undefined)
      await this.secrets.set(providerSecretName(config.id), config.apiKey);
  }

  async remove(id: string) {
    await this.db.run(`DELETE FROM neo_providers WHERE id = ?`, id);
    await this.secrets.delete(providerSecretName(id));
  }

  private async rows() {
    return this.db.all<ProviderRow>(`SELECT * FROM neo_providers ORDER BY id`);
  }
}

export class ModelCatalog {
  private current: Models = createModels();
  private readonly extra: Provider[] = [];

  models = () => this.current;

  addHostProvider(provider: Provider) {
    this.extra.push(provider);
  }

  async rebuild(providers: ResolvedProvider[]) {
    const credentials = new InMemoryCredentialStore();
    const models: MutableModels = createModels({
      credentials,
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
    for (const provider of this.extra) models.setProvider(provider);
    for (const p of providers) {
      models.setProvider(build(p));
      const env = p.env && Object.keys(p.env).length > 0 ? p.env : undefined;
      if (p.apiKey || env) {
        const credential: Credential = {
          type: "api_key",
          ...(p.apiKey ? { key: p.apiKey } : {}),
          ...(env ? { env } : {}),
        };
        await credentials.modify(p.id, async () => credential);
      }
    }
    this.current = models;
  }

  async available(): Promise<{ provider: string; id: string; name: string }[]> {
    const models = await this.current.getAvailable();
    return models.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
    }));
  }

  vision(model: ModelRef) {
    return (
      this.current
        .getModel(model.provider, model.modelId)
        ?.input.includes("image") ?? true
    );
  }
}

function build(p: ResolvedProvider) {
  if (p.kind !== "openai-compatible") return BUILTIN[p.kind]();
  const { baseUrl } = p;
  const models = p.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions" as const,
    provider: p.id,
    baseUrl,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
  }));
  return createProvider({
    id: p.id,
    name: p.id,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${p.id} API key`, []) },
    models,
    api: openAICompletionsApi(),
  });
}

function toConfig(row: ProviderRow) {
  return parse(ProviderSetup, {
    id: row.id,
    kind: row.kind,
    env: parseJson(StringMap, row.env),
    ...(row.kind === "openai-compatible"
      ? {
          baseUrl: row.base_url,
          models: parseJson(Type.Array(CustomModel), row.models),
        }
      : {}),
  });
}
