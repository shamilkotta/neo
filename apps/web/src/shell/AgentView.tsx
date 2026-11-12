import type { AgentSummary } from "@neo/client";
import {
  AlarmClock,
  Brain,
  FolderOpen,
  Lightbulb,
  ListChecks,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Composer, type ComposerHandle, DropOverlay } from "../chat/Composer";
import { Queue } from "../chat/Queue";
import { Thread } from "../chat/Thread";
import { cn, modKey } from "../lib/format";
import { attempt } from "../lib/toast";
import { session as sessionFor } from "../state/agent";
import type { Instance } from "../state/instance";
import { toggleSidebar, ui } from "../state/ui";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { activityOf } from "./activity";
import { DetailsDrawer } from "./DetailsDrawer";

export function AgentView({
  instance,
  agent,
  onDeleted,
}: {
  instance: Instance;
  agent: AgentSummary;
  onDeleted: () => void;
}) {
  const session = sessionFor(instance.root, agent.id);
  useEffect(() => session.attach(), [session]);
  const state = session.state.use();
  const error = session.error.use();
  const status = instance.status.use();
  const details = ui.details.use();
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const running = !!state?.turn;
  const paused = state?.state === "active" ? state.agent.paused : !!agent.status?.paused;
  const activity = state ? (paused ? "paused" : running ? "working" : "idle") : activityOf(agent);
  const model = status?.model ? status.model.modelId : undefined;

  useEffect(() => {
    const title = agent.name === "Neo" ? "Neo" : `${agent.name} · Neo`;
    document.title = running ? `● ${title}` : title;
  }, [agent.name, running]);

  const drag = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depth.current++;
      setDragging(true);
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      composer.current?.add(e.dataTransfer.files);
    },
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col" {...drag}>
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-2.5 sm:px-3">
          <IconButton label="Agents" className="min-[900px]:hidden" onClick={() => toggleSidebar(true)}>
            <PanelLeft className="size-[18px]" />
          </IconButton>
          <button
            type="button"
            onClick={() => ui.details.set(details ? null : "profile")}
            className="flex min-w-0 items-center gap-2 rounded-lg py-1 pr-2 pl-1 transition-colors hover:bg-hover"
          >
            <Avatar id={agent.id} size={22} activity={activity === "working" ? undefined : activity} />
            <span className="truncate text-[14px] font-semibold">{agent.name}</span>
            {activity === "working" ? (
              <span className="shimmer-text text-[12.5px] font-medium">Working</span>
            ) : activity === "paused" ? (
              <span className="text-[12.5px] text-warn">Paused</span>
            ) : (
              agent.title && <span className="hidden truncate text-[12.5px] text-muted sm:inline">{agent.title}</span>
            )}
          </button>
          <span className="flex-1" />
          {running && (
            <Button size="sm" variant="ghost" icon={<Square className="size-3 fill-current" />} onClick={() => void attempt(() => session.client.stop().then(session.refresh))}>
              Stop
            </Button>
          )}
          {paused && (
            <Button size="sm" variant="primary" icon={<Play className="size-3.5 fill-current" />} onClick={() => void attempt(() => session.client.resume().then(session.refresh))}>
              Resume
            </Button>
          )}
          <button
            type="button"
            onClick={() => ui.settings.set(status?.model ? "general" : "providers")}
            className="flex h-7 max-w-[140px] items-center sm:max-w-[240px] gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg sm:flex"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", model ? "bg-ok" : "bg-warn")} />
            <span className="truncate">{model ?? "Choose a model"}</span>
          </button>
          <HeaderMenu
            paused={paused}
            onPause={() => void attempt(() => (paused ? session.client.resume() : session.client.pause()).then(session.refresh), paused ? "Resumed" : "Paused")}
          />
          <IconButton label={`Details (${modKey}.)`} active={!!details} onClick={() => ui.details.set(details ? null : "profile")}>
            <PanelRight className="size-[18px]" />
          </IconButton>
        </header>
        {error && (
          <div className="mx-auto mb-2 w-full max-w-[760px] px-4">
            <div className="flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/8 px-3 py-2 text-[12.5px] text-danger">
              {error}
              <button className="ml-auto font-medium underline" onClick={() => void session.refresh()}>
                Retry
              </button>
            </div>
          </div>
        )}
        <Thread
          session={session}
          name={agent.name}
          empty={<Empty name={agent.name} id={agent.id} description={agent.description} onPick={(t) => composer.current?.fill(t)} />}
        />
        <Queue session={session} />
        <Composer
          ref={composer}
          session={session}
          name={agent.name}
          onNeedsSetup={() => ui.settings.set("providers")}
        />
        <DropOverlay visible={dragging} />
      </div>
      <DetailsDrawer instance={instance} session={session} agent={agent} onDeleted={onDeleted} />
    </div>
  );
}

function HeaderMenu({ paused, onPause }: { paused: boolean; onPause: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const item = (label: string, icon: ReactNode, run: () => void) => (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        run();
      }}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover"
    >
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <IconButton label="More" active={open} onClick={() => setOpen(!open)}>
        <MoreHorizontal className="size-[18px]" />
      </IconButton>
      {open && (
        <div className="animate-pop absolute top-10 right-0 z-30 w-52 rounded-xl border border-line bg-raised p-1 shadow-xl">
          {item(paused ? "Resume agent" : "Pause agent", paused ? <Play className="size-4" /> : <Pause className="size-4" />, onPause)}
          {item("Routines", <AlarmClock className="size-4" />, () => ui.details.set("routines"))}
          {item("Files", <FolderOpen className="size-4" />, () => ui.details.set("files"))}
          {item("Edit profile", <Brain className="size-4" />, () => ui.details.set("profile"))}
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  { icon: AlarmClock, title: "Set up a routine", text: "Every weekday at 9am, send me a short brief of what's on my plate." },
  { icon: Brain, title: "Teach it about you", text: "Here's what you should know about me and how I like to work: " },
  { icon: ListChecks, title: "Plan something", text: "Help me plan my week. Ask me what I need to get done first." },
  { icon: Lightbulb, title: "Remind me", text: "Remind me in 30 minutes to " },
];

function Empty({ name, id, description, onPick }: { name: string; id: string; description: string | null; onPick: (t: string) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 py-10">
      <div className="animate-up flex w-full max-w-[640px] flex-col items-center">
        <Avatar id={id} size={64} />
        <h1 className="mt-5 text-center text-[24px] font-semibold tracking-tight">{greeting}</h1>
        <p className="mt-1.5 max-w-md text-center text-[14.5px] text-muted">
          {description ?? `${name} is always on. Ask anything, hand off work, or set up routines that run on their own.`}
        </p>
        <div className="mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => onPick(s.text)}
              style={{ animationDelay: `${60 + i * 40}ms` }}
              className="animate-up group flex items-start gap-3 rounded-[14px] border border-line-strong p-3.5 text-left transition-colors [animation-fill-mode:backwards] hover:bg-hover"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-sunken text-muted transition-colors group-hover:text-fg">
                <s.icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium">{s.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted">{s.text}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
