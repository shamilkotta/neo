import type { AgentClient, InputMessage, Turn } from "@neo/client";
import {
  AlarmClock,
  ArrowDown,
  Bot,
  Check,
  Copy,
  CornerDownRight,
  Info,
  TriangleAlert,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentSession } from "../state/agent";
import { clock, cn, dayLabel } from "../lib/format";
import { Spinner } from "../ui/Avatar";
import { IconButton } from "../ui/Button";
import { type Block, type Segment, toBlocks } from "./blocks";
import { FileCard } from "./Files";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./Question";
import { ToolGroup, ToolRow } from "./Tools";

const COLUMN = "mx-auto w-full max-w-[760px] px-4 sm:px-6";

export function Thread({
  session,
  name,
  empty,
}: {
  session: AgentSession;
  name: string;
  empty: ReactNode;
}) {
  const thread = session.thread.use();
  const state = session.state.use();
  const activeTurn = state?.turn?.id ?? null;
  const blocks = useMemo(
    () => toBlocks(thread.items, thread.turns, activeTurn),
    [thread.items, thread.turns, activeTurn],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const loadingOlder = useRef(false);
  const anchor = useRef<number | null>(null);

  const toBottom = useCallback((smooth?: boolean) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop += el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [toBottom, thread.loaded]);

  useEffect(() => {
    const el = top.current;
    if (!el || !thread.older) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loadingOlder.current) return;
        loadingOlder.current = true;
        anchor.current = scroller.current?.scrollHeight ?? null;
        void session.loadOlder().finally(() => {
          loadingOlder.current = false;
        });
      },
      { root: scroller.current, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [session, thread.older]);

  const nothing = thread.loaded && blocks.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="h-full overflow-y-auto overscroll-contain"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          pinned.current = near;
          setAway(!near);
        }}
      >
        <div ref={content} className="flex min-h-full flex-col">
          {!thread.loaded ? (
            <ThreadSkeleton />
          ) : nothing ? (
            <LiveOrEmpty session={session} empty={empty} />
          ) : (
            <div className={cn(COLUMN, "flex flex-col pt-6 pb-10")}>
              <div ref={top} />
              {thread.older && (
                <div className="flex justify-center py-3 text-faint">
                  <Spinner />
                </div>
              )}
              {blocks.map((b) => (
                <BlockView key={b.key} block={b} client={session.client} name={name} />
              ))}
              <Live session={session} />
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => toBottom(true)}
        aria-label="Jump to latest"
        className={cn(
          "absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-raised text-muted shadow-lg transition-all duration-200 hover:text-fg",
          away ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        <ArrowDown className="size-4" />
      </button>
    </div>
  );
}

function LiveOrEmpty({ session, empty }: { session: AgentSession; empty: ReactNode }) {
  const live = session.live.use();
  if (!live.active) return <>{empty}</>;
  return (
    <div className={cn(COLUMN, "pt-6")}>
      <Live session={session} />
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className={cn(COLUMN, "flex flex-col gap-8 pt-10")}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="ml-auto h-9 w-2/5 animate-pulse rounded-2xl bg-sunken" />
          <div className="h-3.5 w-11/12 animate-pulse rounded bg-sunken" />
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-sunken" />
        </div>
      ))}
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  client,
  name,
}: {
  block: Block;
  client: AgentClient;
  name: string;
}) {
  switch (block.kind) {
    case "day":
      return (
        <div className="flex justify-center py-3">
          <span className="rounded-full border border-line bg-bg/90 px-2.5 py-0.5 text-[11.5px] font-medium text-muted backdrop-blur">
            {dayLabel(block.at)}
          </span>
        </div>
      );
    case "note":
      return (
        <div className="my-4 flex items-center gap-3 text-[11.5px] text-faint">
          <span className="h-px flex-1 bg-line" />
          {block.text}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "input":
      return (
        <InputView client={client} message={block.message} steered={block.steered} turn={block.turn} />
      );
    case "reply":
      return <ReplyView client={client} segments={block.segments} name={name} />;
  }
});

function InputView({
  client,
  message: m,
  steered,
  turn,
}: {
  client: AgentClient;
  message: InputMessage;
  steered: boolean;
  turn?: Turn;
}) {
  const failed = turn && (turn.status === "failed" || turn.status === "interrupted");
  if (m.source !== "user")
    return (
      <div className="turn my-3 flex flex-col gap-1">
        <SourceTag message={m} />
        {m.text && (
          <details className="group ml-6 text-[13px] text-muted">
            <summary className="cursor-pointer list-none truncate hover:text-fg [&::-webkit-details-marker]:hidden">
              {m.text.split("\n")[0]}
            </summary>
            <div className="mt-1 whitespace-pre-wrap">{m.text}</div>
          </details>
        )}
      </div>
    );
  return (
    <div className="turn group mt-4 flex flex-col items-end gap-1">
      {m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {m.attachments.map((f) => (
            <FileCard key={f.path} client={client} file={f} />
          ))}
        </div>
      )}
      {m.answer ? (
        <div className="flex max-w-[85%] items-center gap-2 rounded-2xl rounded-br-md bg-sunken px-3.5 py-2 text-[14px]">
          <CornerDownRight className="size-3.5 text-faint" />
          {Object.values(m.answer.answers).join(" · ")}
        </div>
      ) : (
        m.text && (
          <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-raised px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap shadow-[0_0_0_1px_var(--line)] [overflow-wrap:anywhere] dark:bg-[#1f1f23]">
            {m.text}
          </div>
        )
      )}
      <div className="flex h-6 items-center gap-1 text-[11.5px] text-faint">
        {steered && <span>joined the running turn ·</span>}
        <span className="opacity-0 transition-opacity group-hover:opacity-100">{clock(m.at)}</span>
        {m.text && <CopyButton text={m.text} subtle />}
      </div>
      {failed && (
        <div className="flex items-center gap-1.5 self-start text-[12.5px] text-danger">
          <TriangleAlert className="size-3.5" />
          {turn.error ?? (turn.status === "interrupted" ? "Stopped" : "Failed")}
        </div>
      )}
    </div>
  );
}

function SourceTag({ message: m }: { message: InputMessage }) {
  const Icon = m.source === "schedule" ? AlarmClock : m.source === "agent" ? Bot : Info;
  const label = m.source === "schedule" ? "Routine" : m.source === "agent" ? "From another agent" : "System";
  return (
    <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
      <span className="flex size-4 items-center justify-center">
        <Icon className="size-3.5" />
      </span>
      {label}
      <span className="font-normal text-faint">· {clock(m.at)}</span>
    </div>
  );
}

function ReplyView({
  client,
  segments,
  name,
}: {
  client: AgentClient;
  segments: Segment[];
  name: string;
}) {
  const text = segments
    .filter((s): s is Segment & { kind: "text" } => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");
  return (
    <div className="turn group flex flex-col gap-2 py-1">
      {segments.map((s) => (
        <SegmentView key={s.key} client={client} segment={s} />
      ))}
      {text && (
        <div className="-ml-1.5 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100">
          <CopyButton text={text} />
          <span className="ml-1 text-[11.5px] text-faint">{name}</span>
        </div>
      )}
    </div>
  );
}

function SegmentView({ client, segment: s }: { client: AgentClient; segment: Segment }) {
  switch (s.kind) {
    case "text":
      return (
        <div className="text-[15px]">
          <Markdown text={s.text} />
        </div>
      );
    case "tools":
      return (
        <ToolGroup count={s.steps.length} running={s.steps.some((t) => t.state === "running")}>
          {s.steps.map((t) => (
            <ToolRow key={t.id} name={t.name} args={t.args} output={t.output} state={t.state} />
          ))}
        </ToolGroup>
      );
    case "ask":
      return <QuestionCard client={client} ask={s.ask} />;
    case "file":
      return <FileCard client={client} file={s.file} caption={s.file.caption} />;
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger/8 px-3 py-2 text-[13px] text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {s.text}
        </div>
      );
  }
}

function Live({ session }: { session: AgentSession }) {
  const live = session.live.use();
  if (!live.active) return null;
  return (
    <div className="flex flex-col gap-2 py-1">
      {live.tools.map((t) => (
        <ToolRow key={t.id} name={t.name} output={t.output} state="running" />
      ))}
      {live.text ? (
        <div className="text-[15px]">
          <Markdown text={live.text} streaming />
        </div>
      ) : (
        live.tools.length === 0 && (
          <div className="flex items-center gap-2 py-1 text-[13.5px]">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-1.5 animate-bounce rounded-full bg-faint"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </span>
            <span className="shimmer-text font-medium">Thinking</span>
          </div>
        )
      )}
    </div>
  );
}

function CopyButton({ text, subtle }: { text: string; subtle?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : "Copy"}
      size="sm"
      className={cn(subtle && "size-6 opacity-0 group-hover:opacity-100")}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        })
      }
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

