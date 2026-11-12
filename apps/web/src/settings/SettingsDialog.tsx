import { type ModelRef, type ProviderConfig, type ProviderInfo, type ProviderSetup, ThinkingLevel } from "@neo/client";
import { Check, Info, KeyRound, LogOut, Monitor, Moon, Plus, SlidersHorizontal, Sun, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import Value from "typebox/value";
import { cn } from "../lib/format";
import { setTheme, theme } from "../lib/theme";
import { attempt } from "../lib/toast";
import { useLoad } from "../lib/useLoad";
import type { Instance } from "../state/instance";
import { type SettingsSection, ui } from "../state/ui";
import { Spinner } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { confirm } from "../ui/confirm";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select } from "../ui/Field";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Info }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "about", label: "About", icon: Info },
];

export function SettingsDialog({ instance, onForget }: { instance: Instance; onForget: () => void }) {
  const section = ui.settings.use();
  return (
    <Dialog open={!!section} onClose={() => ui.settings.set(null)} bare className="sm:w-[760px]">
      {section && (
        <div className="flex h-[min(600px,85dvh)] flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 border-line p-2 max-sm:overflow-x-auto max-sm:border-b sm:w-48 sm:flex-col sm:border-r sm:bg-panel sm:p-3">
            <div className="hidden px-2 pt-1 pb-3 text-[15px] font-semibold sm:block">Settings</div>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => ui.settings.set(s.id)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                  section === s.id ? "bg-hover text-fg" : "text-muted hover:text-fg",
                )}
              >
                <s.icon className="size-4" />
                {s.label}
              </button>
            ))}
          </nav>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <IconButton label="Close" className="absolute top-3 right-3 z-10" onClick={() => ui.settings.set(null)}>
              <X className="size-4" />
            </IconButton>
            <div className="p-6 pt-5">
              {section === "general" && <General instance={instance} />}
              {section === "providers" && <Providers instance={instance} />}
              {section === "about" && <About instance={instance} onForget={onForget} />}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Heading({ title, body }: { title: string; body?: string }) {
  return (
    <div className="mb-5 pr-8">
      <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
      {body && <p className="mt-1 text-[13px] text-muted">{body}</p>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-4 first:pt-0 last:border-b-0 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-muted">{hint}</div>}
      </div>
      <div className="sm:w-64">{children}</div>
    </div>
  );
}

const key = (m: ModelRef | null | undefined) => (m ? `${m.provider}/${m.modelId}` : "");
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function General({ instance }: { instance: Instance }) {
  const version = instance.settingsVersion.use();
  const t = theme.use();
  const { value, error, reload } = useLoad(
    async () => ({ settings: await instance.root.settings(), models: await instance.root.models() }),
    [instance, version],
  );
  const [tz, setTz] = useState("");
  useEffect(() => {
    if (value) setTz(value.settings.timezone);
  }, [value]);
  const save = (change: Parameters<typeof instance.root.updateSettings>[0]) =>
    void attempt(() => instance.root.updateSettings(change), "Saved").then(() => {
      reload();
      void instance.refresh();
    });
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <>
      <Heading title="General" body="Applies to every agent on this instance." />
      {error && <p className="mb-4 text-[13px] text-danger">{error}</p>}
      <Row label="Appearance">
        <div className="flex rounded-xl bg-sunken p-0.5">
          {([
            ["light", Sun, "Light"],
            ["dark", Moon, "Dark"],
            ["system", Monitor, "System"],
          ] as const).map(([id, I, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTheme(id)}
              className={cn("flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[10px] text-[12.5px] font-medium transition-all", t === id ? "bg-raised shadow-sm" : "text-muted hover:text-fg")}
            >
              <I className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </Row>
      {!value ? (
        <div className="flex justify-center py-10 text-faint">
          <Spinner />
        </div>
      ) : (
        <>
          <Row label="Model" hint={value.models.models.length ? "Used by every agent." : "Add a provider first."}>
            <Select
              value={key(value.settings.model)}
              onChange={(e) => {
                const v = e.target.value;
                const slash = v.indexOf("/");
                save({ model: v ? { provider: v.slice(0, slash), modelId: v.slice(slash + 1) } : null });
              }}
            >
              <option value="">Default ({key(value.models.default) || "none"})</option>
              {value.settings.model && !value.models.models.some((m) => key({ provider: m.provider, modelId: m.id }) === key(value.settings.model)) && (
                <option value={key(value.settings.model)}>{key(value.settings.model)}</option>
              )}
              {[...new Set(value.models.models.map((m) => m.provider))].map((provider) => (
                <optgroup key={provider} label={provider}>
                  {value.models.models.filter((m) => m.provider === provider).map((m) => (
                    <option key={m.id} value={`${m.provider}/${m.id}`}>
                      {m.name || m.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Row>
          <Row label="Thinking" hint="How hard the model reasons before answering.">
            <Select
              value={value.settings.thinking ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                save({ thinking: Value.Check(ThinkingLevel, v) ? v : null });
              }}
            >
              <option value="">Default</option>
              {THINKING.map((l) => (
                <option key={l} value={l}>
                  {l[0]!.toUpperCase() + l.slice(1)}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Timezone" hint="Routines and reminders run in this timezone.">
            <div className="flex gap-2">
              <Input value={tz} onChange={(e) => setTz(e.target.value)} onBlur={() => tz !== value.settings.timezone && save({ timezone: tz })} />
              {tz !== browserTz && (
                <Button size="md" onClick={() => {
                  setTz(browserTz);
                  save({ timezone: browserTz });
                }}>
                  Use mine
                </Button>
              )}
            </div>
          </Row>
        </>
      )}
    </>
  );
}

const KINDS = [
  { kind: "anthropic", label: "Anthropic", body: "Claude models" },
  { kind: "openai", label: "OpenAI", body: "GPT models" },
  { kind: "openrouter", label: "OpenRouter", body: "Hundreds of models, one key" },
  { kind: "openai-compatible", label: "Custom", body: "Ollama, LM Studio, vLLM, Groq…" },
] as const;

type Kind = (typeof KINDS)[number]["kind"];

function Providers({ instance }: { instance: Instance }) {
  const version = instance.settingsVersion.use();
  const status = instance.status.use();
  const { value: providers, error, reload } = useLoad(() => instance.root.providers(), [instance, version]);
  const [adding, setAdding] = useState<Kind | null>(null);
  const [found, setFound] = useState<ProviderConfig[]>([]);
  useEffect(() => {
    if (status?.capabilities.sockets) instance.root.detectProviders().then(setFound, () => {});
  }, [instance, status?.capabilities.sockets]);
  const done = () => {
    setAdding(null);
    reload();
    void instance.refresh();
  };
  return (
    <>
      <Heading title="Providers" body="Keys are encrypted with this instance's data key." />
      {error && <p className="mb-4 text-[13px] text-danger">{error}</p>}
      {providers?.length === 0 && !adding && (
        <div className="mb-4 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-3 text-[13px]">Add a provider to start chatting.</div>
      )}
      <div className="flex flex-col gap-2">
        {providers?.map((p: ProviderInfo) => (
          <div key={p.id} className="flex items-center gap-3 rounded-2xl border border-line bg-raised p-3">
            <ProviderMark id={p.kind} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{p.id}</div>
              <div className="truncate text-[12px] text-muted">
                {p.kind === "openai-compatible" ? `${p.baseUrl} · ${p.models.map((m) => m.id).join(", ")}` : p.kind}
              </div>
            </div>
            {p.hasKey && (
              <span className="flex items-center gap-1 rounded-full bg-ok/10 px-2 py-0.5 text-[11.5px] font-medium text-ok">
                <Check className="size-3" /> Key set
              </span>
            )}
            <IconButton
              label="Remove"
              size="sm"
              onClick={async () => {
                if (await confirm({ title: `Remove ${p.id}?`, body: "Its key is deleted. Agents using its models stop working until you pick another.", action: "Remove", danger: true }))
                  void attempt(() => instance.root.removeProvider(p.id), "Removed").then(done);
              }}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        ))}
      </div>
      {found.filter((f) => !providers?.some((p) => p.id === f.id)).length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[12px] font-medium text-muted">Found on this machine</div>
          {found.filter((f) => !providers?.some((p) => p.id === f.id)).map((p) => (
            <div key={p.id} className="mb-2 flex items-center gap-3 rounded-2xl border border-dashed border-line-strong p-3">
              <ProviderMark id={p.kind} />
              <div className="min-w-0 flex-1 text-[13px]">
                {p.id} · {p.kind === "openai-compatible" ? p.models.length : 0} models
              </div>
              <Button size="sm" onClick={() => void attempt(() => instance.root.putProvider(p), "Added").then(done)}>
                Add
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-6">
        {adding ? (
          <AddProvider instance={instance} kind={adding} onCancel={() => setAdding(null)} onDone={done} />
        ) : (
          <>
            <div className="mb-2 text-[12px] font-medium text-muted">Add a provider</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setAdding(k.kind)}
                  className="flex items-center gap-3 rounded-2xl border border-line p-3 text-left transition-colors hover:border-line-strong hover:bg-hover"
                >
                  <ProviderMark id={k.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium">{k.label}</span>
                    <span className="block truncate text-[12px] text-muted">{k.body}</span>
                  </span>
                  <Plus className="size-4 text-faint" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ProviderMark({ id }: { id: string }) {
  const letter = id === "openai-compatible" ? "⚙" : id[0]!.toUpperCase();
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-sunken text-[13px] font-semibold text-muted">
      {letter}
    </span>
  );
}

function AddProvider({ instance, kind, onCancel, onDone }: { instance: Instance; kind: Kind; onCancel: () => void; onDone: () => void }) {
  const [id, setId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const custom = kind === "openai-compatible";
  const label = KINDS.find((k) => k.kind === kind)!.label;
  const ready = custom ? id && baseUrl && models : apiKey;
  return (
    <form
      className="animate-up flex flex-col gap-4 rounded-2xl border border-line bg-panel p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const setup: ProviderSetup = custom
          ? {
              id: id.trim(),
              kind,
              baseUrl: baseUrl.trim(),
              models: models.split(",").map((s) => s.trim()).filter(Boolean).map((m) => ({ id: m })),
            }
          : builtin(kind);
        const ok = await attempt(() => instance.root.putProvider(apiKey ? { ...setup, apiKey } : setup), `${label} added`);
        setBusy(false);
        if (ok !== undefined) onDone();
      }}
    >
      <div className="flex items-center gap-3">
        <ProviderMark id={kind} />
        <div className="text-[14px] font-semibold">{label}</div>
      </div>
      {custom && (
        <>
          <Field label="Id">
            <Input autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="ollama" />
          </Field>
          <Field label="Base URL">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" />
          </Field>
          <Field label="Models" hint="Comma separated">
            <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="llama3.2, qwen3" />
          </Field>
        </>
      )}
      <Field label={custom ? "API key (if it needs one)" : "API key"}>
        <Input autoFocus={!custom} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </div>
    </form>
  );
}

function About({ instance, onForget }: { instance: Instance; onForget: () => void }) {
  const status = instance.status.use();
  const rows: [string, string | undefined][] = [
    ["Version", status?.version],
    ["Host", status?.host],
    ["Instance", status?.instanceId],
    ["State", status?.state],
    ["Agents", String(status?.agents?.length ?? 0)],
  ];
  return (
    <>
      <Heading title="About" />
      <div className="overflow-hidden rounded-2xl border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 text-[13px] last:border-b-0">
            <span className="text-muted">{k}</span>
            <span className="truncate font-mono text-[12px]">{v ?? "—"}</span>
          </div>
        ))}
      </div>
      <Button
        className="mt-6"
        variant="danger"
        icon={<LogOut className="size-4" />}
        onClick={async () => {
          if (await confirm({ title: "Disconnect?", body: "This browser forgets the token. Your agents keep running.", action: "Disconnect", danger: true })) onForget();
        }}
      >
        Disconnect
      </Button>
    </>
  );
}

function builtin(kind: Exclude<Kind, "openai-compatible">): ProviderSetup {
  switch (kind) {
    case "anthropic":
      return { id: kind, kind };
    case "openai":
      return { id: kind, kind };
    case "openrouter":
      return { id: kind, kind };
  }
}
