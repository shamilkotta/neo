import type { LiveEvent, MailboxMessage, NeoClient, NeoEvent, Status, TranscriptItem, Turn } from "@neo/client";
import { useCallback, useEffect, useRef, useState } from "react";

/** The running turn as it streams: the answer so far and the tools still running. */
export interface LiveTurn {
  active: boolean;
  text: string;
  tools: { id: string; name: string; output: string }[];
}

const IDLE: LiveTurn = { active: false, text: "", tools: [] };

/**
 * Everything the chat shows for one instance, kept current from the event stream: status,
 * transcript (with older pages on demand), queue, and the live turn.
 */
export function useNeo(client: NeoClient, onDurable?: (e: NeoEvent) => void) {
  const [status, setStatus] = useState<Status>();
  const [items, setItems] = useState<Map<number, TranscriptItem>>(new Map());
  const [turns, setTurns] = useState<Record<string, Turn>>({});
  const [older, setOlder] = useState<number | null>(null);
  const [queue, setQueue] = useState<MailboxMessage[]>([]);
  const [live, setLive] = useState<LiveTurn>(IDLE);
  const [error, setError] = useState<string>();
  const durable = useRef(onDurable);
  durable.current = onDurable;

  const loadTranscript = useCallback(
    async (before?: number) => {
      const page = await client.transcript({ limit: 100, ...(before ? { before } : {}) });
      setItems((current) => {
        const next = new Map(current);
        // A fresh newest page replaces what it covers (items can change while a turn runs).
        if (!before) {
          const min = page.items[0]?.entryId ?? Number.POSITIVE_INFINITY;
          for (const id of next.keys()) if (id >= min) next.delete(id);
        }
        for (const item of page.items) next.set(item.entryId, item);
        return next;
      });
      setTurns((t) => ({ ...t, ...page.turns }));
      if (before || page.before === null || older === null) setOlder(page.before);
    },
    [client, older],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, q] = await Promise.all([client.status(), client.queue()]);
      setStatus(s);
      setQueue(q);
      if (!s.turn) setLive(IDLE);
      await loadTranscript();
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, loadTranscript]);

  // Many events arrive together; one refresh covers them.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const soon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 60);
  }, [refresh]);

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    void (async () => {
      const first = await client.status().catch((e) => {
        setError(e.message);
        return undefined;
      });
      if (cancelled) return;
      await refresh();
      stop = client.events(
        {
          durable: (e) => {
            if (/^(turn|message|queue|agent)\./.test(e.type)) soon();
            durable.current?.(e);
          },
          live: (e) => setLive((current) => applyLive(current, e, soon)),
          error: () => soon(),
        },
        first?.latestEvent ?? 0,
      );
    })();
    return () => {
      cancelled = true;
      stop();
    };
    // Subscribe once per client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const sorted = [...items.values()].sort((a, b) => a.entryId - b.entryId);
  return { status, items: sorted, turns, older, queue, live, error, refresh, loadOlder: () => older && loadTranscript(older) };
}

/** Applies one of Pi's live events (run, message, tool) to the streaming view. */
function applyLive(current: LiveTurn, event: LiveEvent, settle: () => void): LiveTurn {
  const e = event.data as { type: string; [k: string]: any };
  switch (e.type) {
    case "run_start":
      return { active: true, text: "", tools: [] };
    case "message_start":
      return e.message?.role === "assistant" ? { ...current, active: true, text: "" } : current;
    case "message_update": {
      let text = current.text;
      for (const c of e.changes ?? []) if (c.type === "text_delta") text += c.delta;
      return { ...current, active: true, text };
    }
    case "message_end":
      settle();
      return { ...current, text: "" };
    case "tool_execution_start":
      return { ...current, active: true, tools: [...current.tools, { id: e.toolCallId, name: e.toolName, output: "" }] };
    case "tool_execution_update":
      return {
        ...current,
        tools: current.tools.map((t) =>
          t.id !== e.toolCallId
            ? t
            : { ...t, output: e.output?.set !== undefined ? e.output.set : t.output + (e.output?.append ?? "") },
        ),
      };
    case "tool_execution_end":
      settle();
      return { ...current, tools: current.tools.filter((t) => t.id !== e.toolCallId) };
    case "run_end":
      settle();
      return IDLE;
    default:
      return current;
  }
}
