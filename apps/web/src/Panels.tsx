import type {
  AgentRecord,
  AvailableModel,
  ModelRef,
  NeoClient,
  ProviderConfig,
  ProviderInfo,
  SettingsShape,
  Schedule,
  Status,
} from "@neo/client";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";

export const TABS = ["Schedules", "Agent", "Providers", "Settings", "Files"] as const;
export type Tab = (typeof TABS)[number];

interface PanelProps {
  client: NeoClient;
  /** Bumped when an event says this panel's data changed. */
  version: number;
  status?: Status;
  onForget: () => void;
}

/** Loads with `load`, again when `version` changes; shows errors in place. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [T | undefined, () => void, string | undefined] {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    load().then(
      (v) => {
        setValue(v);
        setError(undefined);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return [value, reload, error];
}

const attempt = async (fn: () => Promise<unknown>, then?: () => void) => {
  try {
    await fn();
    then?.();
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
};

function Form({ onSubmit, children }: { onSubmit: (data: FormData) => Promise<unknown>; children: ReactNode }) {
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        void attempt(() => onSubmit(new FormData(form)), () => form.reset());
      }}
    >
      {children}
    </form>
  );
}

export function Panel({ tab, ...props }: PanelProps & { tab: Tab }) {
  switch (tab) {
    case "Schedules":
      return <SchedulesPanel {...props} />;
    case "Agent":
      return <AgentPanel {...props} />;
    case "Providers":
      return <ProvidersPanel {...props} />;
    case "Settings":
      return <SettingsPanel {...props} />;
    case "Files":
      return <FilesPanel {...props} />;
  }
}


function describe(s: Schedule): string {
  if (s.spec.kind === "once") return `once, ${new Date(s.spec.at).toLocaleString()}`;
  if (s.spec.kind === "every") return `every ${s.spec.minutes} min`;
  return `cron ${s.spec.expr}`;
}

function SchedulesPanel({ client, version }: PanelProps) {
  const [schedules, reload, error] = useLoad(() => client.schedules(), [client, version]);
  return (
    <>
      <p className="muted">
        Everything Neo does on its own time: reminders, routines and the heartbeat.
      </p>
      {error && <p className="err">{error}</p>}
      {schedules?.length === 0 && <p className="muted">None.</p>}
      {schedules?.map((s: Schedule) => (
        <div className="row" key={s.id}>
          <b>{s.name}</b> · {describe(s)}
          {s.window && ` · ${s.window.start}–${s.window.end}`} · {s.createdBy}
          <div className="muted">
            {s.nextAt ? `next ${new Date(s.nextAt).toLocaleString()}` : s.enabled ? "done" : "off"} · ran {s.runCount}
            {s.quiet && " · quiet"}
            {s.whenBusy === "skip" && " · skips when busy"}
          </div>
          <div>{s.prompt.length > 200 ? `${s.prompt.slice(0, 200)}…` : s.prompt}</div>
          <div className="actions">
            <button className="small" onClick={() => attempt(() => client.toggleSchedule(s.id, !s.enabled), reload)}>
              {s.enabled ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

const modelKey = (m: ModelRef | null | undefined) => (m ? `${m.provider}/${m.modelId}` : "");

function AgentPanel({ client, version }: PanelProps) {
  const [data, reload, error] = useLoad(
    async () => ({ agent: await client.agent(), models: await client.models() }),
    [client, version],
  );
  if (error) return <p className="err">{error}</p>;
  if (!data) return null;
  const { agent, models } = data as { agent: AgentRecord; models: { models: AvailableModel[]; default: ModelRef | null } };
  return (
    <form
      key={agent.updatedAt}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const model = String(f.get("model") ?? "");
        const slash = model.indexOf("/");
        void attempt(
          () =>
            client.updateAgent({
              name: String(f.get("name")),
              model: model ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : null,
              thinking: (String(f.get("thinking")) || null) as AgentRecord["thinking"],
            }),
          reload,
        );
      }}
    >
      <label>Name</label>
      <input name="name" defaultValue={agent.name} />
      <label>Model</label>
      <select name="model" defaultValue={modelKey(agent.model)}>
        <option value="">Default ({modelKey(models.default) || "none"})</option>
        {models.models.map((m) => (
          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
            {m.provider}/{m.id}
          </option>
        ))}
      </select>
      <label>Thinking</label>
      <select name="thinking" defaultValue={agent.thinking ?? ""}>
        {["", "off", "minimal", "low", "medium", "high"].map((t) => (
          <option key={t} value={t}>
            {t || "default"}
          </option>
        ))}
      </select>
      <p className="muted">The heartbeat is in Schedules.</p>
      <button className="primary">Save</button>
    </form>
  );
}

function ProvidersPanel({ client, version, status }: PanelProps) {
  const [providers, reload, error] = useLoad(() => client.providers(), [client, version]);
  const [found, setFound] = useState<ProviderConfig[]>([]);
  const [kind, setKind] = useState<ProviderConfig["kind"]>("anthropic");
  useEffect(() => {
    if (status?.capabilities.sockets) client.detectProviders().then(setFound, () => {});
  }, [client, status?.capabilities.sockets]);
  const compat = kind === "openai-compatible";
  return (
    <>
      <p className="muted">Keys are encrypted with this instance's data key.</p>
      {error && <p className="err">{error}</p>}
      {providers?.length === 0 && <p className="err">No provider yet: add one to start chatting.</p>}
      {providers?.map((p: ProviderInfo) => (
        <div className="row" key={p.id}>
          <b>{p.id}</b> · {p.kind}
          {p.baseUrl && ` · ${p.baseUrl}`}
          {p.hasKey && " · key set"}
          {!!p.models?.length && <div className="muted">{p.models.map((m) => m.id).join(", ")}</div>}
          <div className="actions">
            <button className="small" onClick={() => confirm(`Remove ${p.id}?`) && attempt(() => client.removeProvider(p.id), reload)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {found.length > 0 && (
        <>
          <h3>Found on this machine</h3>
          {found.map((p) => (
            <div className="row" key={p.id}>
              {p.id} · {p.models?.length ?? 0} models{" "}
              <button className="small" onClick={() => attempt(() => client.putProvider(p), reload)}>
                Add
              </button>
            </div>
          ))}
        </>
      )}
      <Form
        onSubmit={(f) => {
          const apiKey = String(f.get("apiKey") ?? "");
          const config: ProviderConfig = compat
            ? {
                id: String(f.get("id")),
                kind,
                baseUrl: String(f.get("baseUrl")),
                models: String(f.get("models"))
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((id) => ({ id })),
              }
            : { id: kind, kind };
          if (apiKey) config.apiKey = apiKey;
          return client.putProvider(config).then(reload);
        }}
      >
        <h3>Add a provider</h3>
        <label>Kind</label>
        <select value={kind} onChange={(e) => setKind(e.target.value as ProviderConfig["kind"])}>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="openrouter">openrouter</option>
          <option value="openai-compatible">OpenAI-compatible (Ollama, LM Studio, vLLM, Groq…)</option>
        </select>
        {compat && (
          <>
            <label>Id</label>
            <input name="id" placeholder="ollama" required />
            <label>Base URL</label>
            <input name="baseUrl" placeholder="http://127.0.0.1:11434/v1" required />
            <label>Models (comma separated)</label>
            <input name="models" placeholder="llama3.2" required />
          </>
        )}
        <label>API key{compat && " (if it needs one)"}</label>
        <input name="apiKey" type="password" />
        <button className="primary">Save</button>
      </Form>
    </>
  );
}

function SettingsPanel({ client, version, status, onForget }: PanelProps) {
  const [settings, reload, error] = useLoad(() => client.settings(), [client, version]);
  if (error) return <p className="err">{error}</p>;
  if (!settings) return null;
  const s = settings as SettingsShape;
  return (
    <>
      <form
        key={JSON.stringify(s)}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void attempt(
            () =>
              client.updateSettings({
                timezone: String(f.get("timezone")),
              }),
            reload,
          );
        }}
      >
        <label>Your timezone</label>
        <input name="timezone" id="tz" defaultValue={s.timezone} />
        <button
          type="button"
          className="small"
          onClick={() => {
            (document.getElementById("tz") as HTMLInputElement).value = Intl.DateTimeFormat().resolvedOptions().timeZone;
          }}
        >
          Use this browser's
        </button>
        <button className="primary">Save</button>
      </form>
      <p className="muted">
        Instance {status?.instanceId} on {status?.host} · Neo {status?.version}
      </p>
      <button className="small" onClick={onForget}>
        Disconnect (forget token)
      </button>
    </>
  );
}

function FilesPanel({ client }: PanelProps) {
  const [path, setPath] = useState("/");
  const [entry, , error] = useLoad(() => client.file(path), [client, path]);
  const up = path.replace(/\/[^/]+$/, "") || "/";
  return (
    <>
      <p className="muted">Neo's workspace · {path}</p>
      {error && <p className="err">{error}</p>}
      {path !== "/" && (
        <div className="row">
          <a href="#" onClick={(e) => (e.preventDefault(), setPath(up))}>
            ..
          </a>
        </div>
      )}
      {entry?.kind === "directory" &&
        (entry.entries.length === 0 ? (
          <p className="muted">Empty.</p>
        ) : (
          entry.entries.map((e) => (
            <div className="row" key={e.path}>
              <a href="#" onClick={(ev) => (ev.preventDefault(), setPath(e.path))}>
                {e.name}
                {e.kind === "directory" ? "/" : ""}
              </a>{" "}
              <span className="muted">{e.kind === "file" ? `${e.size} B` : ""}</span>
            </div>
          ))
        ))}
      {entry?.kind === "file" && <pre className="file">{entry.text.slice(0, 50_000)}</pre>}
    </>
  );
}
