import type { AgentSummary } from "@neo/client";
import { Monitor, Moon, PanelLeft, Plus, Search, Settings, Sun } from "lucide-react";
import { cn, modKey } from "../lib/format";
import { cycleTheme, theme } from "../lib/theme";
import type { Instance } from "../state/instance";
import { toggleSidebar, ui } from "../state/ui";
import { Avatar } from "../ui/Avatar";
import { activityOf } from "./activity";

export function Sidebar({
  instance,
  agents,
  current,
  onChoose,
}: {
  instance: Instance;
  agents: AgentSummary[];
  current?: string;
  onChoose: (id: string) => void;
}) {
  const open = ui.sidebar.use();
  const primary = agents.find((a) => a.primary);
  const rest = agents.filter((a) => a !== primary);
  return (
    <>
      <div
        onClick={() => toggleSidebar(false)}
        className={cn(
          "fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 min-[900px]:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        className={cn(
          "z-40 flex h-full shrink-0 flex-col overflow-hidden bg-bg transition-[width,transform] duration-250 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:w-[288px] max-[899px]:shadow-2xl",
          open ? "min-[900px]:w-[288px]" : "max-[899px]:-translate-x-full min-[900px]:w-[76px]",
        )}
      >
        {open ? (
          <div className="flex h-12 shrink-0 items-center gap-1.5 px-3">
            <Round label={`Collapse (${modKey}B)`} onClick={() => toggleSidebar(false)}>
              <PanelLeft className="size-[17px]" />
            </Round>
            <span className="flex-1" />
            <Round label={`Search (${modKey}K)`} onClick={() => ui.palette.set(true)}>
              <Search className="size-[17px]" />
            </Round>
            <Round label={`New agent (${modKey}⇧O)`} onClick={() => ui.newAgent.set(true)}>
              <Plus className="size-[17px]" />
            </Round>
          </div>
        ) : (
          <div className="flex h-12 shrink-0 items-center justify-center">
            <Round label={`Expand (${modKey}B)`} onClick={() => toggleSidebar(true)}>
              <PanelLeft className="size-[17px]" />
            </Round>
          </div>
        )}
        <nav className={cn("flex-1 overflow-y-auto pb-3", open ? "px-2" : "px-2.5")}>
          {primary &&
            (open ? (
              <button
                type="button"
                onClick={() => onChoose(primary.id)}
                aria-current={primary.id === current || undefined}
                className={cn(
                  "mb-2 flex w-full flex-col items-center gap-2 rounded-2xl py-4 transition-colors",
                  primary.id === current ? "bg-raised" : "hover:bg-hover",
                )}
              >
                <Avatar id={primary.id} size={72} activity={activityOf(primary)} />
                <span className="text-[14px] font-semibold">{primary.name}</span>
              </button>
            ) : (
              <>
                <Mini agent={primary} on={primary.id === current} onChoose={onChoose} size={44} />
                {rest.length > 0 && <div className="mx-auto my-2 h-px w-8 bg-line" />}
              </>
            ))}
          {rest.map((a) =>
            open ? (
              <AgentRow key={a.id} agent={a} on={a.id === current} onChoose={onChoose} />
            ) : (
              <Mini key={a.id} agent={a} on={a.id === current} onChoose={onChoose} size={40} />
            ),
          )}
        </nav>
        <Footer instance={instance} open={open} />
      </aside>
    </>
  );
}

function Footer({ instance, open }: { instance: Instance; open: boolean }) {
  const t = theme.use();
  const status = instance.status.use();
  const ThemeIcon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5 p-3", open ? "flex-row" : "flex-col")}>
      {!open && (
        <Round label={`New agent (${modKey}⇧O)`} onClick={() => ui.newAgent.set(true)}>
          <Plus className="size-[17px]" />
        </Round>
      )}
      <Round label={`Settings (${modKey},)`} onClick={() => ui.settings.set("general")}>
        <Settings className="size-[17px]" />
        {status?.model === null && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warn" />}
      </Round>
      <Round label={`Theme: ${t}`} onClick={cycleTheme}>
        <ThemeIcon className="size-[17px]" />
      </Round>
    </div>
  );
}

function Round({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative flex size-9 items-center justify-center rounded-full bg-raised text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function Mini({
  agent: a,
  on,
  onChoose,
  size,
}: {
  agent: AgentSummary;
  on: boolean;
  onChoose: (id: string) => void;
  size: number;
}) {
  return (
    <button
      type="button"
      title={a.name}
      aria-label={a.name}
      onClick={() => onChoose(a.id)}
      aria-current={on || undefined}
      className={cn(
        "mb-1 flex w-full items-center justify-center rounded-2xl py-1.5 transition-colors",
        on ? "bg-raised" : "hover:bg-hover",
      )}
    >
      <Avatar id={a.id} size={size} activity={activityOf(a)} />
    </button>
  );
}

function AgentRow({ agent: a, on, onChoose }: { agent: AgentSummary; on: boolean; onChoose: (id: string) => void }) {
  const activity = activityOf(a);
  const line =
    activity === "working" ? "Working…" : activity === "paused" ? "Paused" : (a.description ?? "Ready when you are");
  return (
    <button
      type="button"
      onClick={() => onChoose(a.id)}
      aria-current={on || undefined}
      className={cn(
        "mb-0.5 flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-colors",
        on ? "bg-raised" : "hover:bg-hover",
      )}
    >
      <Avatar id={a.id} size={40} activity={activity} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14.5px] font-semibold">{a.name}</span>
          {a.title && <span className="truncate text-[13px] text-muted">· {a.title}</span>}
          {a.status?.queued ? (
            <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] leading-4 font-semibold text-white tabular-nums">
              {a.status.queued}
            </span>
          ) : null}
        </span>
        <span className={cn("mt-px block truncate text-[13px]", activity === "working" ? "text-ok" : "text-muted")}>{line}</span>
      </span>
    </button>
  );
}
