import type { AgentSummary } from "@neo/client";
import { Monitor, Moon, PanelLeftClose, Plus, Search, Settings, Sun } from "lucide-react";
import { Logo } from "../App";
import { cn, modKey } from "../lib/format";
import { cycleTheme, theme } from "../lib/theme";
import type { Instance } from "../state/instance";
import { toggleSidebar, ui } from "../state/ui";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/Button";
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
  return (
    <>
      <div
        onClick={() => toggleSidebar(false)}
        className={cn(
          "fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 min-[900px]:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        className={cn(
          "z-40 flex h-full shrink-0 bg-bg transition-[width,transform] duration-250 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:w-[328px] max-[899px]:shadow-2xl",
          open ? "min-[900px]:w-[332px]" : "max-[899px]:-translate-x-full min-[900px]:w-[52px]",
        )}
      >
        <Rail instance={instance} />
        <aside
          className={cn(
            "flex w-[280px] min-w-0 flex-col overflow-hidden transition-opacity duration-200 max-[899px]:w-[276px]",
            !open && "min-[900px]:pointer-events-none min-[900px]:opacity-0",
          )}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-3">
            <span className="text-[14px] font-semibold tracking-tight">Agents</span>
            <span className="text-[12px] text-faint tabular-nums">{agents.length}</span>
            <span className="flex-1" />
            <IconButton label={`New agent (${modKey}⇧O)`} size="sm" onClick={() => ui.newAgent.set(true)}>
              <Plus className="size-4" />
            </IconButton>
            <IconButton label={`Collapse (${modKey}B)`} size="sm" onClick={() => toggleSidebar(false)}>
              <PanelLeftClose className="size-4" />
            </IconButton>
          </div>
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => ui.palette.set(true)}
              className="flex h-8 w-full items-center gap-2 rounded-lg bg-sunken px-2.5 text-[13px] text-muted transition-colors hover:text-fg"
            >
              <Search className="size-3.5" />
              Search
              <span className="ml-auto text-[11.5px] text-faint">{modKey}K</span>
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-3">
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} on={a.id === current} onChoose={onChoose} />
            ))}
          </nav>
        </aside>
      </div>
    </>
  );
}

function Rail({ instance }: { instance: Instance }) {
  const t = theme.use();
  const status = instance.status.use();
  const open = ui.sidebar.use();
  const ThemeIcon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
  return (
    <nav aria-label="Pages" className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 py-2">
      <button type="button" aria-label="Toggle agents" onClick={() => toggleSidebar(!open)} className="mb-2 rounded-[9px] transition-transform active:scale-95">
        <Logo className="size-8" />
      </button>
      <RailButton label={`Search (${modKey}K)`} onClick={() => ui.palette.set(true)}>
        <Search className="size-[18px]" />
      </RailButton>
      <RailButton label="New agent" onClick={() => ui.newAgent.set(true)}>
        <Plus className="size-[18px]" />
      </RailButton>
      <span className="flex-1" />
      <RailButton label={`Theme: ${t}`} onClick={cycleTheme}>
        <ThemeIcon className="size-[18px]" />
      </RailButton>
      <RailButton label={`Settings (${modKey},)`} onClick={() => ui.settings.set("general")}>
        <Settings className="size-[18px]" />
        {status?.model === null && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warn" />}
      </RailButton>
    </nav>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative flex size-9 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function AgentRow({ agent: a, on, onChoose }: { agent: AgentSummary; on: boolean; onChoose: (id: string) => void }) {
  const activity = activityOf(a);
  const line =
    activity === "working"
      ? "Working…"
      : activity === "paused"
        ? "Paused"
        : (a.description ?? (a.primary ? "Your main agent" : "Ready when you are"));
  return (
    <button
      type="button"
      onClick={() => onChoose(a.id)}
      aria-current={on || undefined}
      className={cn(
        "mb-0.5 flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
        on ? "bg-raised" : "hover:bg-hover",
      )}
    >
      <Avatar id={a.id} size={36} activity={activity} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-semibold">{a.name}</span>
          {a.title && (
            <span className="truncate rounded-md bg-sunken px-1.5 py-px text-[11.5px] text-muted">{a.title}</span>
          )}
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
