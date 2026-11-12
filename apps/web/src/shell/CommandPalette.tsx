import type { AgentSummary } from "@neo/client";
import { AlarmClock, CornerDownLeft, KeyRound, type LucideIcon, Monitor, PanelLeft, Plus, Search, Settings, UserRound } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn, modKey } from "../lib/format";
import { cycleTheme } from "../lib/theme";
import { toggleSidebar, ui } from "../state/ui";
import { Avatar, Kbd } from "../ui/Avatar";
import { Dialog } from "../ui/Dialog";

interface Command {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

const icon = (I: LucideIcon) => <I className="size-4" />;

export function CommandPalette({ agents, onChoose }: { agents: AgentSummary[]; onChoose: (id: string) => void }) {
  const open = ui.palette.use();
  return (
    <Dialog open={open} onClose={() => ui.palette.set(false)} bare className="sm:w-[560px]">
      {open && <Palette agents={agents} onChoose={onChoose} />}
    </Dialog>
  );
}

function Palette({ agents, onChoose }: { agents: AgentSummary[]; onChoose: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const commands = useMemo<Command[]>(
    () => [
      ...agents.map((a, n) => ({
        id: `agent-${a.id}`,
        label: a.name,
        group: "Agents",
        icon: <Avatar id={a.id} name={a.name} size={20} />,
        hint: n < 9 ? `${modKey}${n + 1}` : undefined,
        run: () => onChoose(a.id),
      })),
      { id: "new", label: "New agent", group: "Actions", icon: icon(Plus), hint: `${modKey}⇧O`, run: () => ui.newAgent.set(true) },
      { id: "profile", label: "Edit agent profile", group: "Actions", icon: icon(UserRound), hint: `${modKey}.`, run: () => ui.details.set("profile") },
      { id: "routines", label: "Routines", group: "Actions", icon: icon(AlarmClock), run: () => ui.details.set("routines") },
      { id: "sidebar", label: "Toggle sidebar", group: "Actions", icon: icon(PanelLeft), hint: `${modKey}B`, run: () => toggleSidebar() },
      { id: "theme", label: "Switch theme", group: "Preferences", icon: icon(Monitor), run: cycleTheme },
      { id: "settings", label: "Settings", group: "Preferences", icon: icon(Settings), hint: `${modKey},`, run: () => ui.settings.set("general") },
      { id: "providers", label: "Providers and API keys", group: "Preferences", icon: icon(KeyRound), run: () => ui.settings.set("providers") },
    ],
    [agents, onChoose],
  );
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.group}`.toLowerCase().includes(w)));
  }, [commands, q]);
  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);
  const run = (c: Command | undefined) => {
    if (!c) return;
    ui.palette.set(false);
    c.run();
  };
  let lastGroup = "";
  return (
    <div className="flex max-h-[min(480px,80dvh)] flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="size-4 text-faint" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setI((n) => Math.min(n + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setI((n) => Math.max(n - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(shown[i]);
            }
          }}
          placeholder="Search agents and actions…"
          className="h-12 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-faint"
        />
        <Kbd>esc</Kbd>
      </div>
      <div ref={list} className="overflow-y-auto p-1.5">
        {shown.length === 0 && <div className="py-10 text-center text-[13px] text-muted">No results</div>}
        {shown.map((c, n) => {
          const header = c.group !== lastGroup;
          lastGroup = c.group;
          return (
            <div key={c.id}>
              {header && <div className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium text-faint">{c.group}</div>}
              <button
                type="button"
                data-i={n}
                onMouseMove={() => setI(n)}
                onClick={() => run(c)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px]", n === i && "bg-hover")}
              >
                <span className="flex size-5 items-center justify-center text-muted">{c.icon}</span>
                <span className="flex-1 truncate">{c.label}</span>
                {n === i ? <CornerDownLeft className="size-3.5 text-faint" /> : c.hint && <span className="text-[11.5px] text-faint">{c.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
