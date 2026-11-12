import type { AgentSummary } from "@neo/client";
import { Monitor, Moon, PanelLeftClose, Plus, Search, Settings, Sun } from "lucide-react";
import { Logo } from "../App";
import { cn, modKey } from "../lib/format";
import { cycleTheme, theme } from "../lib/theme";
import type { Instance } from "../state/instance";
import { toggleSidebar, ui } from "../state/ui";
import { Avatar, Kbd } from "../ui/Avatar";
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
  const t = theme.use();
  const status = instance.status.use();
  const ThemeIcon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
  return (
    <>
      <div
        onClick={() => toggleSidebar(false)}
        className={cn(
          "fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 min-[900px]:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        className={cn(
          "z-40 flex h-full shrink-0 flex-col overflow-hidden border-line bg-panel transition-[width,transform] duration-250 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          "max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:w-[288px] max-[899px]:border-r max-[899px]:shadow-2xl",
          open ? "min-[900px]:w-[264px] min-[900px]:border-r" : "max-[899px]:-translate-x-full min-[900px]:w-0",
        )}
      >
        <div className="flex w-[264px] flex-1 flex-col max-[899px]:w-[288px]">
          <div className="flex h-14 items-center gap-2.5 px-3.5">
            <Logo className="size-7" />
            <span className="text-[15px] font-semibold tracking-tight">Neo</span>
            <span className="flex-1" />
            <IconButton label={`Search (${modKey}K)`} size="sm" onClick={() => ui.palette.set(true)}>
              <Search className="size-4" />
            </IconButton>
            <IconButton label={`Close sidebar (${modKey}B)`} size="sm" onClick={() => toggleSidebar(false)}>
              <PanelLeftClose className="size-4" />
            </IconButton>
          </div>
          <div className="px-2.5 pb-2">
            <button
              type="button"
              onClick={() => ui.newAgent.set(true)}
              className="group flex h-9 w-full items-center gap-2.5 rounded-xl border border-line bg-raised px-3 text-[13px] font-medium shadow-[0_1px_0_var(--line)] transition-colors hover:border-line-strong"
            >
              <Plus className="size-4 text-muted" />
              New agent
              <span className="ml-auto hidden gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 sm:flex">
                <Kbd>{modKey}</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>O</Kbd>
              </span>
            </button>
          </div>
          <div className="px-4 pt-3 pb-1.5 text-[11.5px] font-medium tracking-wide text-faint">Agents</div>
          <nav className="flex-1 overflow-y-auto px-2 pb-2">
            {agents.map((a, i) => {
              const activity = activityOf(a);
              const on = a.id === current;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onChoose(a.id)}
                  className={cn(
                    "group mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors",
                    on ? "bg-raised shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.04)]" : "hover:bg-hover",
                  )}
                >
                  <Avatar id={a.id} name={a.name} size={30} activity={activity} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-medium">{a.name}</span>
                    </span>
                    <span className={cn("block truncate text-[12px]", activity === "working" ? "text-ok" : "text-muted")}>
                      {activity === "working"
                        ? "Working…"
                        : activity === "paused"
                          ? "Paused"
                          : (a.title ?? (a.primary ? "Primary agent" : "Idle"))}
                    </span>
                  </span>
                  {a.status?.queued ? (
                    <span className="rounded-full bg-brand/12 px-1.5 text-[11px] font-semibold text-brand">{a.status.queued}</span>
                  ) : i < 9 ? (
                    <span className="hidden text-[11px] text-faint opacity-0 group-hover:opacity-100 sm:block">
                      {modKey}
                      {i + 1}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <div className="flex items-center gap-1 border-t border-line p-2">
            <button
              type="button"
              onClick={() => ui.settings.set("general")}
              className="flex h-9 flex-1 items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <Settings className="size-4" />
              Settings
              {status?.model === null && <span className="size-1.5 rounded-full bg-warn" />}
            </button>
            <IconButton label={`Theme: ${t}`} onClick={cycleTheme}>
              <ThemeIcon className="size-4" />
            </IconButton>
          </div>
        </div>
      </aside>
    </>
  );
}
