import type { AgentSummary, Schedule } from "@neo/client";
import {
  AlarmClock,
  ChevronRight,
  Download,
  File,
  Folder,
  HardDrive,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { FileCard, isImage } from "../chat/Files";
import { bytes, cn, relative } from "../lib/format";
import { attempt } from "../lib/toast";
import { useLoad } from "../lib/useLoad";
import type { AgentSession } from "../state/agent";
import type { Instance } from "../state/instance";
import { type DetailsTab, ui } from "../state/ui";
import { Avatar, Spinner } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { confirm } from "../ui/confirm";
import { Field, Input, Switch, Textarea } from "../ui/Field";

const TABS: { id: DetailsTab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "routines", label: "Routines" },
  { id: "files", label: "Files" },
];

export function DetailsDrawer({
  instance,
  session,
  agent,
  onDeleted,
}: {
  instance: Instance;
  session: AgentSession;
  agent: AgentSummary;
  onDeleted: () => void;
}) {
  const tab = ui.details.use();
  if (!tab) return null;
  return (
    <>
      <div className="animate-in fixed inset-0 z-30 bg-black/40 min-[1100px]:hidden" onClick={() => ui.details.set(null)} />
      <aside className="animate-drawer z-40 flex w-[min(400px,100vw)] shrink-0 flex-col border-l border-line bg-panel max-[1099px]:fixed max-[1099px]:inset-y-0 max-[1099px]:right-0 max-[1099px]:shadow-2xl">
        <div className="flex h-14 shrink-0 items-center gap-1 px-3">
          <div className="flex rounded-xl bg-sunken p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => ui.details.set(t.id)}
                className={cn(
                  "h-7 rounded-[10px] px-3 text-[12.5px] font-medium transition-all",
                  tab === t.id ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <IconButton label="Close" onClick={() => ui.details.set(null)}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {tab === "profile" && <Profile instance={instance} session={session} agent={agent} onDeleted={onDeleted} />}
          {tab === "routines" && <Routines session={session} />}
          {tab === "files" && <Files session={session} />}
        </div>
      </aside>
    </>
  );
}

function Profile({
  instance,
  session,
  agent,
  onDeleted,
}: {
  instance: Instance;
  session: AgentSession;
  agent: AgentSummary;
  onDeleted: () => void;
}) {
  const state = session.state.use();
  const paused = state?.state === "active" ? state.agent.paused : !!agent.status?.paused;
  const [draft, setDraft] = useState({
    name: agent.name,
    title: agent.title ?? "",
    description: agent.description ?? "",
    instructions: agent.instructions ?? "",
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft({
      name: agent.name,
      title: agent.title ?? "",
      description: agent.description ?? "",
      instructions: agent.instructions ?? "",
    });
  }, [agent.updatedAt]);
  const dirty =
    draft.name !== agent.name ||
    draft.title !== (agent.title ?? "") ||
    draft.description !== (agent.description ?? "") ||
    draft.instructions !== (agent.instructions ?? "");
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <form
      className="flex flex-col gap-4 pt-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        await attempt(
          () =>
            instance.root.updateAgent(agent.id, {
              name: draft.name.trim() || agent.name,
              title: draft.title.trim() || null,
              description: draft.description.trim() || null,
              instructions: draft.instructions.trim() || null,
            }),
          "Saved",
        );
        setSaving(false);
        void instance.refresh();
      }}
    >
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-raised p-3">
        <Avatar id={agent.id} name={draft.name || agent.name} size={44} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{draft.name || agent.name}</div>
          <div className="text-[12px] text-muted">
            {agent.primary ? "Primary agent" : "Agent"} · created {relative(agent.createdAt)}
          </div>
        </div>
      </div>
      <Field label="Name">
        <Input value={draft.name} onChange={set("name")} />
      </Field>
      <Field label="Title" hint="A short role, shown under the name.">
        <Input value={draft.title} onChange={set("title")} placeholder="Research assistant" />
      </Field>
      <Field label="Description">
        <Textarea value={draft.description} onChange={set("description")} rows={2} placeholder="What this agent is for" />
      </Field>
      <Field label="Instructions" hint="Always in its prompt. The model is chosen in Settings.">
        <Textarea value={draft.instructions} onChange={set("instructions")} rows={7} placeholder="How it should behave, what it should focus on…" />
      </Field>
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-panel px-4 py-3">
        <Button type="submit" variant="primary" disabled={!dirty || saving}>
          {saving ? <Spinner /> : "Save changes"}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft({ name: agent.name, title: agent.title ?? "", description: agent.description ?? "", instructions: agent.instructions ?? "" })}>
            Discard
          </Button>
        )}
      </div>
      <div className="mt-2 rounded-2xl border border-line p-3.5">
        <div className="text-[13px] font-medium">{paused ? "Paused" : "Pause agent"}</div>
        <p className="mt-0.5 text-[12.5px] text-muted">
          {paused
            ? "New messages and routines wait until you resume."
            : "Stops picking up new messages and routines until you resume."}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant={paused ? "primary" : "secondary"}
          icon={paused ? <Play className="size-3.5 fill-current" /> : <Pause className="size-3.5" />}
          onClick={() =>
            void attempt(
              () => (paused ? session.client.resume() : session.client.pause()).then(session.refresh),
              paused ? "Resumed" : "Paused",
            )
          }
        >
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      {!agent.primary && (
        <div className="mt-2 rounded-2xl border border-danger/20 p-3.5">
          <div className="text-[13px] font-medium">Delete agent</div>
          <p className="mt-0.5 text-[12.5px] text-muted">Its chat, memories, routines and files are removed for good.</p>
          <Button
            className="mt-3"
            size="sm"
            variant="danger"
            icon={<Trash2 className="size-3.5" />}
            onClick={async () => {
              if (!(await confirm({ title: `Delete ${agent.name}?`, body: "Its chat, memories, routines and files go too. This can't be undone.", action: "Delete", danger: true }))) return;
              const ok = await attempt(() => instance.root.deleteAgent(agent.id), `${agent.name} deleted`);
              if (ok !== undefined) {
                ui.details.set(null);
                onDeleted();
                void instance.refresh();
              }
            }}
          >
            Delete {agent.name}
          </Button>
        </div>
      )}
    </form>
  );
}

function describe(s: Schedule) {
  if (s.spec.kind === "once") return new Date(s.spec.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  if (s.spec.kind === "every") {
    const m = s.spec.minutes;
    return m % 1440 === 0 ? `Every ${m / 1440 === 1 ? "day" : `${m / 1440} days`}` : m % 60 === 0 ? `Every ${m / 60 === 1 ? "hour" : `${m / 60} hours`}` : `Every ${m} min`;
  }
  return `Cron · ${s.spec.expr}`;
}

function Routines({ session }: { session: AgentSession }) {
  const version = session.changed.use();
  const { value: schedules, error, reload } = useLoad(() => session.client.schedules(), [session, version]);
  if (error) return <p className="pt-2 text-[13px] text-danger">{error}</p>;
  if (!schedules)
    return (
      <div className="flex flex-col gap-2 pt-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-sunken" />
        ))}
      </div>
    );
  if (schedules.length === 0)
    return (
      <div className="flex flex-col items-center px-6 pt-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-sunken text-muted">
          <AlarmClock className="size-5" />
        </div>
        <div className="mt-4 text-[14px] font-medium">No routines yet</div>
        <p className="mt-1 text-[13px] text-muted">Ask in the chat — “every morning at 8, check …” — and it shows up here.</p>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 pt-2">
      <p className="px-1 pb-1 text-[12.5px] text-muted">Everything the agent does on its own time: reminders, routines and the heartbeat.</p>
      {schedules.map((s) => (
        <div key={s.id} className={cn("rounded-2xl border border-line bg-raised p-3.5 transition-opacity", !s.enabled && "opacity-60")}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium">{s.name}</span>
                {s.createdBy === "system" && <span className="rounded-md bg-sunken px-1.5 text-[10.5px] font-medium text-muted">system</span>}
              </div>
              <div className="mt-0.5 text-[12px] text-muted">
                {describe(s)}
                {s.window && ` · ${s.window.start}–${s.window.end}`}
              </div>
            </div>
            <Switch checked={s.enabled} label={s.enabled ? "Turn off" : "Turn on"} onChange={(on) => void attempt(() => session.client.toggleSchedule(s.id, on)).then(reload)} />
          </div>
          <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-fg/80">{s.prompt}</p>
          <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-faint">
            <span>{s.nextAt && s.enabled ? `Next ${relative(s.nextAt)}` : s.enabled ? "Done" : "Off"}</span>
            <span>Ran {s.runCount}×</span>
            {s.lastAt && <span>Last {relative(s.lastAt)}</span>}
            {s.quiet && <span>Quiet</span>}
            {s.whenBusy === "skip" && <span>Skips when busy</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Files({ session }: { session: AgentSession }) {
  const [path, setPath] = useState("/");
  const { value: entry, error } = useLoad(() => session.client.file(path), [session, path]);
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-[12.5px]">
        <button type="button" onClick={() => setPath("/")} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-fg">
          <HardDrive className="size-3.5" /> Files
        </button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center">
            <ChevronRight className="size-3.5 text-faint" />
            <button
              type="button"
              onClick={() => setPath(`/${parts.slice(0, i + 1).join("/")}`)}
              className={cn("rounded-md px-1.5 py-1 hover:bg-hover", i === parts.length - 1 ? "font-medium" : "text-muted")}
            >
              {p}
            </button>
          </span>
        ))}
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {!entry && !error && <div className="h-40 animate-pulse rounded-2xl bg-sunken" />}
      {entry?.kind === "directory" &&
        (entry.entries.length === 0 ? (
          <div className="flex flex-col items-center pt-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-sunken text-muted">
              <Folder className="size-5" />
            </div>
            <div className="mt-4 text-[14px] font-medium">Nothing here yet</div>
            <p className="mt-1 text-[13px] text-muted">Files you send and files the agent makes show up here.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line bg-raised">
            {[...entry.entries]
              .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1))
              .map((e) => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => setPath(e.path)}
                  className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-b-0 hover:bg-hover"
                >
                  {e.kind === "directory" ? <Folder className="size-4 text-brand" /> : <File className="size-4 text-muted" />}
                  <span className="min-w-0 flex-1 truncate text-[13px]">{e.name}</span>
                  <span className="text-[11.5px] text-faint">{e.kind === "file" ? bytes(e.size) : ""}</span>
                </button>
              ))}
          </div>
        ))}
      {entry?.kind === "file" && <FilePreview session={session} path={path} text={entry.text} />}
    </div>
  );
}

function FilePreview({ session, path, text }: { session: AgentSession; path: string; text: string }) {
  const name = path.split("/").pop() ?? path;
  const mime = /\.(png|jpe?g|gif|webp|avif)$/i.test(name) ? `image/${name.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")}` : "text/plain";
  const file = { path, name, mimeType: mime, size: text.length };
  if (isImage(file)) return <FileCard client={session.client} file={file} />;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-raised">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{name}</span>
        <IconButton
          label="Download"
          size="sm"
          onClick={() =>
            void attempt(async () => {
              const href = URL.createObjectURL(await session.client.fileBlob(path));
              const a = document.createElement("a");
              a.href = href;
              a.download = name;
              a.click();
              setTimeout(() => URL.revokeObjectURL(href), 10_000);
            })
          }
        >
          <Download className="size-3.5" />
        </IconButton>
      </div>
      <pre className="max-h-[60vh] overflow-auto p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{text.slice(0, 50_000)}</pre>
    </div>
  );
}
