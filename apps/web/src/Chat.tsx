import type { MailboxMessage, NeoClient, TranscriptItem, Turn } from "@neo/client";
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveTurn } from "./useNeo";

/** Markdown-lite: code blocks, inline code and bold; everything else is plain text. */
function Markdown({ text }: { text: string }) {
  const parts = text.split(/```\w*\n?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <pre key={i}>
            <code>{part}</code>
          </pre>
        ) : (
          <span key={i}>
            {part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((piece, j) =>
              piece.startsWith("`") && piece.endsWith("`") && piece.length > 1 ? (
                <code key={j}>{piece.slice(1, -1)}</code>
              ) : piece.startsWith("**") && piece.endsWith("**") && piece.length > 3 ? (
                <b key={j}>{piece.slice(2, -2)}</b>
              ) : (
                piece
              ),
            )}
          </span>
        ),
      )}
    </>
  );
}

const time = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function Item({ item, turns, results }: { item: TranscriptItem; turns: Record<string, Turn>; results: Map<string, TranscriptItem & { type: "tool" }> }) {
  if (item.type === "input") {
    const turn = turns[item.turnId];
    return (
      <>
        {item.messages.map((m) => (
          <div key={m.id} className={`msg me from-${m.source}`}>
            <div className="meta">
              {m.source === "user" ? "You" : m.source} · {time(m.at)}
              {item.steered && " · joined the turn"}
              {turn && turn.status !== "completed" && <span className={`chip ${turn.status}`}>{turn.status}</span>}
            </div>
            <div className="bubble">{m.text}</div>
            {turn?.error && <div className="err">{turn.error}</div>}
          </div>
        ))}
      </>
    );
  }
  if (item.type === "assistant") {
    if (!item.text && item.toolCalls.length === 0 && !item.error) return null;
    return (
      <div className="msg">
        {item.text && (
          <div className="bubble">
            <Markdown text={item.text} />
          </div>
        )}
        {item.toolCalls.map((call) => {
          const result = results.get(call.id);
          return (
            <details key={call.id} className="tool">
              <summary>
                {result?.isError ? "⚠ " : "▸ "}
                {call.name} {JSON.stringify(call.args).slice(0, 90)}
              </summary>
              <pre>{JSON.stringify(call.args, null, 2)}</pre>
              {result && <pre>{result.output}</pre>}
            </details>
          );
        })}
        {item.error && item.stopReason !== "aborted" && <div className="err">{item.error}</div>}
      </div>
    );
  }
  if (item.type === "compaction") return <div className="note">— earlier conversation summarized —</div>;
  if (item.type === "reset") return <div className="note">— new context —</div>;
  return null;
}

export function Transcript(props: {
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  live: LiveTurn;
  older: number | null;
  loadOlder: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const results = new Map(
    props.items.filter((i): i is TranscriptItem & { type: "tool" } => i.type === "tool").map((i) => [i.toolCallId, i]),
  );
  // Stay at the bottom while new things arrive, unless the person scrolled up.
  useLayoutEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  });
  return (
    <div
      id="log"
      ref={log}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {props.older && (
        <div className="note">
          <button className="small" onClick={props.loadOlder}>
            Load older
          </button>
        </div>
      )}
      {props.items.length === 0 && !props.live.active && <div className="note">Say hello to Neo.</div>}
      {props.items.map((item) => (
        <Item key={item.entryId} item={item} turns={props.turns} results={results} />
      ))}
      {props.live.active && (
        <div className="msg">
          {props.live.tools.map((t) => (
            <details key={t.id} className="tool" open>
              <summary>… {t.name}</summary>
              {t.output && <pre>{t.output.slice(-2000)}</pre>}
            </details>
          ))}
          {props.live.text ? (
            <div className="bubble">
              <Markdown text={props.live.text} />
            </div>
          ) : (
            <div className="muted">working…</div>
          )}
        </div>
      )}
    </div>
  );
}

export function Queue({ client, queue, running, refresh }: { client: NeoClient; queue: MailboxMessage[]; running: boolean; refresh: () => void }) {
  if (queue.length === 0) return null;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  return (
    <div id="queue">
      {queue.map((m, n) => (
        <div className="q" key={m.id}>
          <span className="chip">queued</span>
          <span className="t" title={m.text}>
            {m.text}
          </span>
          {running && (
            <button className="small" onClick={() => act(() => client.steerQueued(m.id))}>
              Join turn
            </button>
          )}
          {n > 0 && (
            <button
              className="small"
              onClick={() =>
                act(() => {
                  const ids = queue.map((q) => q.id);
                  [ids[n - 1], ids[n]] = [ids[n]!, ids[n - 1]!];
                  return client.reorderQueue(ids);
                })
              }
            >
              ↑
            </button>
          )}
          <button
            className="small"
            onClick={() => {
              const text = prompt("Edit the queued message", m.text);
              if (text) void act(() => client.editQueued(m.id, text));
            }}
          >
            Edit
          </button>
          <button className="small" onClick={() => act(() => client.cancelQueued(m.id))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ client, busyDefault, onSent, onNeedsSetup }: { client: NeoClient; busyDefault: "queue" | "steer"; onSent: () => void; onNeedsSetup: () => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState(busyDefault);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setMode(busyDefault), [busyDefault]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    try {
      await client.send(value, { clientId: `web-${crypto.randomUUID()}`, steer: mode === "steer" });
    } catch (err) {
      setText(value);
      const body = (err as { body?: { setup?: boolean } }).body;
      if (body?.setup) onNeedsSetup();
      alert(err instanceof Error ? err.message : String(err));
    }
    onSent();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <form id="composer" onSubmit={submit}>
      <textarea
        ref={input}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="Message Neo… (Enter to send, Shift+Enter for a new line)"
      />
      <select value={mode} onChange={(e) => setMode(e.target.value as "queue" | "steer")} title="When Neo is busy">
        <option value="queue">Queue</option>
        <option value="steer">Join turn</option>
      </select>
      <button className="primary" type="submit">
        Send
      </button>
    </form>
  );
}
