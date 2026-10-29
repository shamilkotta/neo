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
import type { ProviderKind, CustomModel, ProviderConfig } from "@neo/client";
export type { ProviderKind, CustomModel, ProviderConfig } from "@neo/client";

export const PROVIDERS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE neo_providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    base_url TEXT,
    models TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  ) STRICT`);
};

/**
 * Built-in providers use pi-ai's catalog; their id is the pi-ai provider id. Each is imported on
 * its own (never pi-ai's all-providers barrel), so a Worker bundle carries only these SDKs. Any
 * other API (Ollama, LM Studio, vLLM, Groq, DeepSeek, ...) is an OpenAI-compatible provider.
 */
export const BUILTIN_KINDS = [
  "anthropic",
  "openai",
  "openrouter",
] as const satisfies readonly ProviderKind[];

interface ProviderRow {
  id: string;
  kind: ProviderKind;
  base_url: string | null;
  models: string;
  env: string;
  created_at: number;
}

const BUILTIN: Record<(typeof BUILTIN_KINDS)[number], () => Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
};

/** Local model servers Neo looks for (OpenBot detects Ollama and LM Studio). */
const LOCAL_SERVERS = [
  {
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    list: "http://127.0.0.1:11434/api/tags",
    pick: (j: any) => (j.models ?? []).map((m: any) => m.name as string),
  },
  {
    id: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    list: "http://127.0.0.1:1234/v1/models",
    pick: (j: any) => (j.data ?? []).map((m: any) => m.id as string),
  },
];

/** Finds local model servers that answer, as ready-to-save provider configs (no key). */
export async function detectLocalProviders(
  fetcher: typeof fetch = fetch,
): Promise<ProviderConfig[]> {
  const found: ProviderConfig[] = [];
  for (const server of LOCAL_SERVERS) {
    try {
      const response = await fetcher(server.list, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) continue;
      const models = server.pick(await response.json()) as string[];
      if (models.length)
        found.push({
          id: server.id,
          kind: "openai-compatible",
          baseUrl: server.baseUrl,
          models: models.map((id) => ({ id })),
        });
    } catch {
      // Not running here (or this host cannot reach it, as in a Durable Object).
    }
  }
  return found;
}

export const providerSecretName = (id: string) => `provider:${id}`;

/**
 * Model providers of an instance. `models()` is what the harness calls for every request, so a
 * change applies without restarting anything.
 */
export class Providers {
  private current: Models;
  /** Extra providers the host adds (the scripted test provider). Not stored. */
  private readonly extra: Provider[] = [];

  constructor(
    private readonly db: SqliteDatabase,
    private readonly secrets: Secrets,
    private readonly now: () => number = Date.now,
  ) {
    this.current = createModels();
  }

  models = (): Models => this.current;

  addHostProvider(provider: Provider): void {
    this.extra.push(provider);
  }

  async rebuild(): Promise<void> {
    const credentials = new InMemoryCredentialStore();
    // No ambient environment: a key reaches a provider only from Neo's encrypted secrets, so the
    // same instance behaves the same on every host.
    const models: MutableModels = createModels({
      credentials,
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
    for (const provider of this.extra) models.setProvider(provider);
    for (const row of await this.rows()) {
      const key = await this.secrets.get(providerSecretName(row.id));
      const env = JSON.parse(row.env) as Record<string, string>;
      models.setProvider(this.build(row));
      if (key || Object.keys(env).length > 0) {
        const credential: Credential = {
          type: "api_key",
          ...(key ? { key } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        await credentials.modify(row.id, async () => credential);
      }
    }
    this.current = models;
  }

  async list(): Promise<
    (Omit<ProviderConfig, "apiKey"> & { hasKey: boolean })[]
  > {
    const out: (Omit<ProviderConfig, "apiKey"> & { hasKey: boolean })[] = [];
    for (const row of await this.rows()) {
      out.push({
        ...toConfig(row),
        hasKey:
          (await this.secrets.get(providerSecretName(row.id))) !== undefined,
      });
    }
    return out;
  }

  async put(config: ProviderConfig): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.id))
      throw new Error(
        "Provider id must be lowercase letters, digits and dashes",
      );
    if (config.kind === "openai-compatible") {
      if (!config.baseUrl)
        throw new Error("An OpenAI-compatible provider needs baseUrl");
      if (!config.models?.length)
        throw new Error(
          "An OpenAI-compatible provider needs at least one model",
        );
      if ((BUILTIN_KINDS as readonly string[]).includes(config.id))
        throw new Error("That id is reserved for a built-in provider");
    } else if (config.id !== config.kind) {
      throw new Error(
        `A built-in provider's id must be its kind ("${config.kind}")`,
      );
    }
    await this.db.run(
      `INSERT INTO neo_providers (id, kind, base_url, models, env, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, base_url = excluded.base_url, models = excluded.models, env = excluded.env`,
      config.id,
      config.kind,
      config.baseUrl ?? null,
      JSON.stringify(config.models ?? []),
      JSON.stringify(config.env ?? {}),
      this.now(),
    );
    if (config.apiKey !== undefined)
      await this.secrets.set(providerSecretName(config.id), config.apiKey);
    await this.rebuild();
  }

  async remove(id: string): Promise<void> {
    await this.db.run(`DELETE FROM neo_providers WHERE id = ?`, id);
    await this.secrets.delete(providerSecretName(id));
    await this.rebuild();
  }

  /** Models that can be used now (their provider has a key or needs none). */
  async available(): Promise<{ provider: string; id: string; name: string }[]> {
    const models = await this.current.getAvailable();
    return models.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
    }));
  }

  /** One plain completion (channel summaries, routing). Throws on a provider error. */
  async complete(
    model: ModelRef,
    prompt: string,
    system?: string,
  ): Promise<string> {
    const found = this.current.getModel(model.provider, model.modelId);
    if (!found)
      throw new Error(`Unknown model ${model.provider}/${model.modelId}`);
    const answer = await this.current.completeSimple(found, {
      ...(system ? { systemPrompt: system } : {}),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });
    if (answer.stopReason === "error")
      throw new Error(answer.errorMessage ?? "The model failed");
    return answer.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
  }

  async defaultModel(): Promise<ModelRef | undefined> {
    const row = await this.db.get<{ value: string }>(
      `SELECT value FROM neo_meta WHERE key = 'default_model'`,
    );
    return row ? (JSON.parse(row.value) as ModelRef) : undefined;
  }

  async setDefaultModel(model: ModelRef | null): Promise<void> {
    if (model === null)
      await this.db.run(`DELETE FROM neo_meta WHERE key = 'default_model'`);
    else
      await this.db.run(
        `INSERT INTO neo_meta (key, value) VALUES ('default_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify(model),
      );
  }

  private async rows(): Promise<ProviderRow[]> {
    return this.db.all<ProviderRow>(`SELECT * FROM neo_providers ORDER BY id`);
  }

  private build(row: ProviderRow): Provider {
    if (row.kind !== "openai-compatible") {
      const factory = BUILTIN[row.kind];
      if (!factory) throw new Error(`Unknown provider kind ${row.kind}`);
      return factory();
    }
    const baseUrl = row.base_url!;
    const models = (JSON.parse(row.models) as CustomModel[]).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: "openai-completions" as const,
      provider: row.id,
      baseUrl,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 16_384,
    }));
    return createProvider({
      id: row.id,
      name: row.id,
      baseUrl,
      auth: { apiKey: envApiKeyAuth(`${row.id} API key`, []) },
      models,
      api: openAICompletionsApi(),
    });
  }
}

function toConfig(row: ProviderRow): Omit<ProviderConfig, "apiKey"> {
  return {
    id: row.id,
    kind: row.kind,
    baseUrl: row.base_url,
    models: JSON.parse(row.models) as CustomModel[],
    env: JSON.parse(row.env) as Record<string, string>,
  };
}
