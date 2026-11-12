import type { AgentSummary } from "@neo/client";
import { useCallback, useEffect, useState } from "react";
import { Logo } from "../App";
import { cn } from "../lib/format";
import { Instance } from "../state/instance";
import { closeSidebarOnMobile, toggleSidebar, ui } from "../state/ui";
import { Spinner } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { SettingsDialog } from "../settings/SettingsDialog";
import { AgentView } from "./AgentView";
import { CommandPalette } from "./CommandPalette";
import { NewAgentDialog } from "./NewAgentDialog";
import { Sidebar } from "./Sidebar";

const agentFromHash = () => new URLSearchParams(location.hash.slice(1)).get("agent");

export function Workspace({ url, token, onForget }: { url: string; token: string; onForget: () => void }) {
  const [instance] = useState(() => new Instance(url, token));
  const status = instance.status.use();
  const error = instance.error.use();
  const [selected, setSelected] = useState<string | null>(agentFromHash);

  useEffect(() => instance.connect(), [instance]);
  useEffect(() => {
    if (error === "Unauthorized") onForget();
  }, [error, onForget]);
  useEffect(() => {
    const onHash = () => setSelected(agentFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const agents: AgentSummary[] = status?.agents ?? [];
  const current = agents.find((a) => a.id === selected) ?? agents.find((a) => a.primary) ?? agents[0];

  const choose = useCallback((id: string) => {
    setSelected(id);
    history.replaceState(null, "", `#agent=${encodeURIComponent(id)}`);
    closeSidebarOnMobile();
  }, []);

  useShortcuts(agents, current?.id, choose);

  if (!status)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Logo className="size-10 animate-pulse" />
        {error ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="max-w-xs text-[13px] text-muted">Can't reach your instance: {error}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void instance.refresh()}>Retry</Button>
              <Button size="sm" variant="ghost" onClick={onForget}>Use another token</Button>
            </div>
          </div>
        ) : (
          <Spinner className="text-faint" />
        )}
      </div>
    );

  return (
    <div className="flex h-full">
      <Sidebar instance={instance} agents={agents} current={current?.id} onChoose={choose} />
      <main className={cn("relative flex min-w-0 flex-1 flex-col bg-bg")}>
        {current ? (
          <AgentView key={current.id} instance={instance} agent={current} onDeleted={() => choose(agents.find((a) => a.primary)?.id ?? "")} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted">No agents yet.</div>
        )}
      </main>
      <SettingsDialog instance={instance} onForget={onForget} />
      <CommandPalette agents={agents} onChoose={choose} />
      <NewAgentDialog instance={instance} onCreated={choose} />
    </div>
  );
}

function useShortcuts(agents: AgentSummary[], current: string | undefined, choose: (id: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        ui.palette.set(!ui.palette.get());
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (key === ",") {
        e.preventDefault();
        ui.settings.set("general");
      } else if (key === "o" && e.shiftKey) {
        e.preventDefault();
        ui.newAgent.set(true);
      } else if (key === "." ) {
        e.preventDefault();
        ui.details.set(ui.details.get() ? null : "profile");
      } else if ((key === "arrowup" || key === "arrowdown") && e.altKey && agents.length) {
        e.preventDefault();
        const i = agents.findIndex((a) => a.id === current);
        const next = agents[(i + (key === "arrowdown" ? 1 : -1) + agents.length) % agents.length];
        if (next) choose(next.id);
      } else if (/^[1-9]$/.test(key) && !e.shiftKey) {
        const target = agents[Number(key) - 1];
        if (target) {
          e.preventDefault();
          choose(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agents, current, choose]);
}
