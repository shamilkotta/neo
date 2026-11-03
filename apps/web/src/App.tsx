import {
  type AgentClient,
  type AgentId,
  type EventType,
  NeoClient,
  type NeoEvent,
  type Status,
} from "@neo/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Composer, Queue, Transcript } from "./Chat";
import { apiUrl, forgetToken, loadToken, saveToken } from "./config";
import { Panel, TABS, type Tab } from "./Panels";
import { useNeo } from "./useNeo";

const PANEL_EVENTS: Partial<Record<EventType, Tab[]>> = {
  "schedule.changed": ["Schedules"],
  "schedule.fired": ["Schedules"],
  "agent.changed": ["Agent"],
  "providers.changed": ["Providers", "Settings"],
  "settings.changed": ["Settings"],
};

export function App() {
  const url = useMemo(apiUrl, []);
  const [token, setToken] = useState(() => loadToken(url));
  if (!token)
    return (
      <Connect
        url={url}
        onToken={(t) => {
          saveToken(url, t);
          setToken(t);
        }}
      />
    );
  return (
    <Instance
      root={new NeoClient({ url, token })}
      onForget={() => {
        forgetToken(url);
        setToken(null);
      }}
    />
  );
}

function Connect({
  url,
  onToken,
}: {
  url: string;
  onToken: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      id="login"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onToken(value.trim());
      }}
    >
      <h2>Neo</h2>
      <p className="muted">{url}</p>
      <label>API token</label>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <p className="muted">
        Printed by <code>neo serve</code>, or the <code>NEO_TOKEN</code> secret
        on Cloudflare.
      </p>
      <button className="primary">Connect</button>
    </form>
  );
}

const agentFromHash = () =>
  new URLSearchParams(location.hash.slice(1)).get("agent");

function Instance({
  root: initial,
  onForget,
}: {
  root: NeoClient;
  onForget: () => void;
}) {
  const [root] = useState(initial);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(agentFromHash);

  const refresh = useCallback(async () => {
    try {
      setStatus(await root.status());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [root]);

  useEffect(() => {
    void refresh();
    return root.events({
      durable: (e) => {
        if (/^(agent|settings|providers)\./.test(e.type)) void refresh();
      },
      error: () => void refresh(),
    });
  }, [root, refresh]);

  useEffect(() => {
    if (error === "Unauthorized") onForget();
  }, [error, onForget]);

  const agents = status?.agents ?? [];
  const current =
    agents.find((a) => a.id === selected) ??
    agents.find((a) => a.primary) ??
    agents[0];
  const choose = (id: string) => {
    setSelected(id);
    history.replaceState(null, "", `#agent=${encodeURIComponent(id)}`);
  };

  return (
    <div id="app">
      <nav id="agents">
        <h2>Agents</h2>
        {agents.map((a) => (
          <button
            key={a.id}
            className={a.id === current?.id ? "on" : ""}
            onClick={() => choose(a.id)}
          >
            <span
              className={`dot ${
                a.status?.paused
                  ? "paused"
                  : a.status?.working
                    ? "running"
                    : "idle"
              }`}
            />
            {a.name}
            {!!a.status?.queued && (
              <span className="muted"> · {a.status.queued}</span>
            )}
          </button>
        ))}
        <button
          className="small"
          onClick={() => {
            const name = prompt("Name of the new agent")?.trim();
            if (!name) return;
            root.createAgent({ name }).then(
              (agent) => {
                choose(agent.id);
                void refresh();
              },
              (e) => alert(e instanceof Error ? e.message : String(e)),
            );
          }}
        >
          New agent
        </button>
      </nav>
      {error && !current && <p className="err banner">{error}</p>}
      {current && status && (
        <AgentView
          key={current.id}
          root={root}
          agentId={current.id}
          status={status}
          onForget={onForget}
          onDeleted={() => {
            setSelected(null);
            history.replaceState(null, "", location.pathname);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function AgentView({
  root,
  agentId,
  status,
  onForget,
  onDeleted,
}: {
  root: NeoClient;
  agentId: AgentId;
  status: Status;
  onForget: () => void;
  onDeleted: () => void;
}) {
  const [client] = useState<AgentClient>(() => root.agent(agentId));
  const [tab, setTab] = useState<Tab | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const bump = useCallback((e: NeoEvent) => {
    const tabs = PANEL_EVENTS[e.type];
    if (tabs)
      setVersions((v) =>
        Object.fromEntries([
          ...Object.entries(v),
          ...tabs.map((t) => [t, (v[t] ?? 0) + 1]),
        ]),
      );
  }, []);
  const neo = useNeo(client, bump);
  const running = !!neo.status?.turn;
  const active = neo.status?.state === "active" ? neo.status.agent : undefined;
  const paused = !!active?.paused;
  return (
    <>
      <div id="main">
        <header>
          <span
            className={`dot ${paused ? "paused" : running ? "running" : "idle"}`}
          />
          <h1>{active?.name ?? agentId}</h1>
          <span id="state">
            {paused ? "paused" : running ? "working" : "idle"} ·{" "}
            {status.model
              ? `${status.model.provider}/${status.model.modelId}`
              : "no model"}{" "}
            · {status.host}
          </span>
          <span className="grow" />
          {running && (
            <button onClick={() => client.stop().then(neo.refresh)}>
              Stop
            </button>
          )}
          <button
            onClick={() =>
              (paused ? client.resume() : client.pause()).then(neo.refresh)
            }
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={() => setTab(tab ? null : "Schedules")}>
            Panel
          </button>
        </header>
        {neo.error && <p className="err banner">{neo.error}</p>}
        <Transcript
          client={client}
          items={neo.items}
          turns={neo.turns}
          live={neo.live}
          older={neo.older}
          loadOlder={() => void neo.loadOlder()}
        />
        <Queue
          client={client}
          queue={neo.queue}
          running={running}
          refresh={() => void neo.refresh()}
        />
        <Composer
          client={client}
          onSent={() => void neo.refresh()}
          onNeedsSetup={() => setTab("Providers")}
        />
      </div>
      {tab && (
        <aside id="side">
          <div id="tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={t === tab ? "on" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
            <span className="grow" />
            <button className="small" onClick={() => setTab(null)}>
              ✕
            </button>
          </div>
          <div id="pane">
            <Panel
              tab={tab}
              root={root}
              client={client}
              agentId={agentId}
              version={versions[tab] ?? 0}
              status={status}
              onForget={onForget}
              onDeleted={onDeleted}
            />
          </div>
        </aside>
      )}
    </>
  );
}
