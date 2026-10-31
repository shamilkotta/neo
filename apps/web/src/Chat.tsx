import type {
  Attachment,
  MailboxMessage,
  NeoClient,
  TranscriptItem,
  Turn,
} from "@neo/client";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
            {part
              .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
              .map((piece, j) =>
                piece.startsWith("`") &&
                piece.endsWith("`") &&
                piece.length > 1 ? (
                  <code key={j}>{piece.slice(1, -1)}</code>
                ) : piece.startsWith("**") &&
                  piece.endsWith("**") &&
                  piece.length > 3 ? (
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

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Images shown inline, at most this big (the browser holds the whole file to show it). */
const PREVIEW_MAX = 20 * 1024 * 1024;
const PREVIEW_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/**
 * One attached file: a thumbnail for an image, a card for anything else, both with a download.
 * Files need the bearer token, so they are fetched, not linked.
 */
function FileCard({
  client,
  file,
  caption,
}: {
  client: NeoClient;
  file: Attachment;
  caption?: string | null;
}) {
  const [url, setUrl] = useState<string>();
  const preview = PREVIEW_TYPES.test(file.mimeType) && file.size <= PREVIEW_MAX;
  useEffect(() => {
    if (!preview) return;
    let made: string | undefined;
    let gone = false;
    client
      .fileBlob(file.path)
      .then((blob) => {
        if (gone) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, file.path, preview]);
  const download = async () => {
    try {
      const href = url ?? URL.createObjectURL(await client.fileBlob(file.path));
      const a = document.createElement("a");
      a.href = href;
      a.download = file.name;
      a.click();
      if (!url) setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="file">
      {preview && url && (
        <img src={url} alt={file.name} onClick={() => window.open(url)} />
      )}
      <div className="file-row">
        <span className="file-name" title={file.path}>
          {file.name}
        </span>
        <span className="muted">{size(file.size)}</span>
        <button className="small" type="button" onClick={download}>
          Download
        </button>
      </div>
      {caption && <div className="file-caption">{caption}</div>}
    </div>
  );
}

const time = (at: number) =>
  new Date(at).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function Item({
  client,
  item,
  turns,
  results,
}: {
  client: NeoClient;
  item: TranscriptItem;
  turns: Record<string, Turn>;
  results: Map<string, TranscriptItem & { type: "tool" }>;
}) {
  if (item.type === "input") {
    const turn = turns[item.turnId];
    return (
      <>
        {item.messages.map((m) => (
          <div key={m.id} className={`msg me from-${m.source}`}>
            <div className="meta">
              {m.source === "user" ? "You" : m.source} · {time(m.at)}
              {item.steered && " · joined the turn"}
              {turn && turn.status !== "completed" && (
                <span className={`chip ${turn.status}`}>{turn.status}</span>
              )}
            </div>
            {m.text && <div className="bubble">{m.text}</div>}
            {m.attachments?.length ? (
              <div className="files">
                {m.attachments.map((f) => (
                  <FileCard key={f.path} client={client} file={f} />
                ))}
              </div>
            ) : null}
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
          if (result?.file)
            return (
              <div key={call.id} className="files">
                <FileCard
                  client={client}
                  file={result.file}
                  caption={result.file.caption}
                />
              </div>
            );
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
        {item.error && item.stopReason !== "aborted" && (
          <div className="err">{item.error}</div>
        )}
      </div>
    );
  }
  if (item.type === "compaction")
    return <div className="note">— earlier conversation summarized —</div>;
  if (item.type === "reset") return <div className="note">— new context —</div>;
  return null;
}

export function Transcript(props: {
  client: NeoClient;
  items: TranscriptItem[];
  turns: Record<string, Turn>;
  live: LiveTurn;
  older: number | null;
  loadOlder: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const results = new Map(
    props.items
      .filter((i): i is TranscriptItem & { type: "tool" } => i.type === "tool")
      .map((i) => [i.toolCallId, i]),
  );
  // Stay at the bottom while new things arrive, unless the person scrolled up.
  useLayoutEffect(() => {
    if (pinned.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
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
      {props.items.length === 0 && !props.live.active && (
        <div className="note">Say hello to Neo.</div>
      )}
      {props.items.map((item) => (
        <Item
          key={item.entryId}
          client={props.client}
          item={item}
          turns={props.turns}
          results={results}
        />
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

export function Queue({
  client,
  queue,
  running,
  refresh,
}: {
  client: NeoClient;
  queue: MailboxMessage[];
  running: boolean;
  refresh: () => void;
}) {
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
            {m.attachments.length > 0 && `📎${m.attachments.length} `}
            {m.text}
          </span>
          {running && (
            <button
              className="small"
              onClick={() => act(() => client.steerQueued(m.id))}
            >
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
          <button
            className="small"
            onClick={() => act(() => client.cancelQueued(m.id))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer({
  client,
  onSent,
  onNeedsSetup,
}: {
  client: NeoClient;
  onSent: () => void;
  onNeedsSetup: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const add = (list: FileList | File[] | null) => {
    if (list?.length) setFiles((f) => [...f, ...Array.from(list)].slice(0, 10));
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if ((!value && files.length === 0) || sending) return;
    setSending(true);
    try {
      // Each file streams up on its own first; the message then attaches them.
      const attachments = [];
      for (const file of files)
        attachments.push(await client.upload(file, file.name || "file"));
      await client.send(value, {
        clientId: `web-${crypto.randomUUID()}`,
        ...(attachments.length ? { attachments } : {}),
      });
      setText("");
      setFiles([]);
    } catch (err) {
      const body = (err as { body?: { setup?: boolean } }).body;
      if (body?.setup) onNeedsSetup();
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
    onSent();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      add(e.clipboardData.files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    add(e.dataTransfer.files);
  };
  return (
    <form
      id="composer"
      className={dragging ? "dragging" : undefined}
      onSubmit={submit}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <div className="pending">
          {files.map((f, i) => (
            <span className="chip" key={`${f.name}-${i}`}>
              {f.name} · {size(f.size)}
              {!sending && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          title="Attach files"
          disabled={sending}
          onClick={() => picker.current?.click()}
        >
          📎
        </button>
        <textarea
          ref={input}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder="Message Neo… (Enter to send, Shift+Enter for a new line)"
        />
        <button className="primary" type="submit" disabled={sending}>
          {sending ? (files.length ? "Uploading…" : "Sending…") : "Send"}
        </button>
      </div>
    </form>
  );
}
