import { NeoClient, type NeoEvent } from "@neo/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Composer, Queue, Transcript } from "./Chat";
import { apiUrl, forgetToken, loadToken, saveToken } from "./config";
import { Panel, TABS, type Tab } from "./Panels";
import { useNeo } from "./useNeo";

/** Which panel each durable event type refreshes. */
const PANEL_EVENTS: Record<string, Tab[]> = {
  "memory.changed": ["Memory"],
  "wakeup.changed": ["Wake-ups"],
  "wakeup.fired": ["Wake-ups"],
  "agent.changed": ["Agent"],
  "providers.changed": ["Providers", "Agent"],
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
      client={new NeoClient({ url, token })}
      onForget={() => {
        forgetToken(url);
        setToken(null);
      }}
    />
  );
}

function Connect({ url, onToken }: { url: string; onToken: (token: string) => void }) {
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
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      <p className="muted">
        Printed by <code>neo serve</code>, or the <code>NEO_TOKEN</code> secret on Cloudflare.
      </p>
      <button className="primary">Connect</button>
    </form>
  );
}

function Instance({ client: initial, onForget }: { client: NeoClient; onForget: () => void }) {
  // One client for the life of this screen.
  const [client] = useState(initial);
  const [tab, setTab] = useState<Tab | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const bump = useCallback((e: NeoEvent) => {
    const tabs = PANEL_EVENTS[e.type];
    if (tabs) setVersions((v) => Object.fromEntries([...Object.entries(v), ...tabs.map((t) => [t, (v[t] ?? 0) + 1])]));
  }, []);
  const neo = useNeo(client, bump);
  const { status } = neo;
  const running = !!status?.turn;
  const paused = !!status?.agent?.paused;
  const [busyDefault, setBusyDefault] = useState<"queue" | "steer">("queue");
  useEffect(() => {
    client.settings().then((s) => setBusyDefault(s.busyMessageMode), () => {});
  }, [client, versions.Settings]);
  // A wrong or revoked token: back to the connect screen.
  useEffect(() => {
    if (neo.error === "Unauthorized") onForget();
  }, [neo.error, onForget]);
  return (
    <div id="app">
      <div id="main">
        <header>
          <span className={`dot ${paused ? "paused" : running ? "running" : "idle"}`} />
          <h1>{status?.agent?.name ?? "Neo"}</h1>
          <span id="state">
            {paused ? "paused" : running ? "working" : "idle"} ·{" "}
            {status?.model ? `${status.model.provider}/${status.model.modelId}` : "no model"} · {status?.host}
          </span>
          <span className="grow" />
          {running && <button onClick={() => client.stop().then(neo.refresh)}>Stop</button>}
          <button onClick={() => (paused ? client.resume() : client.pause()).then(neo.refresh)}>{paused ? "Resume" : "Pause"}</button>
          <button onClick={() => setTab(tab ? null : "Memory")}>Panel</button>
        </header>
        {neo.error && <p className="err banner">{neo.error}</p>}
        <Transcript items={neo.items} turns={neo.turns} live={neo.live} older={neo.older} loadOlder={() => void neo.loadOlder()} />
        <Queue client={client} queue={neo.queue} running={running} refresh={() => void neo.refresh()} />
        <Composer client={client} busyDefault={busyDefault} onSent={() => void neo.refresh()} onNeedsSetup={() => setTab("Providers")} />
      </div>
      {tab && (
        <aside id="side">
          <div id="tabs">
            {TABS.map((t) => (
              <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
            <span className="grow" />
            <button className="small" onClick={() => setTab(null)}>
              ✕
            </button>
          </div>
          <div id="pane">
            <Panel tab={tab} client={client} version={versions[tab] ?? 0} status={status} onForget={onForget} />
          </div>
        </aside>
      )}
    </div>
  );
}
