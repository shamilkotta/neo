import type { AgentClient, AgentSummary, InputMessage, Turn } from "@neo/client";
import {
  AlarmClock,
  ArrowDown,
  Bot,
  Brain,
  Check,
  Copy,
  CornerDownRight,
  Info,
  type LucideIcon,
  Send,
  Square,
  TriangleAlert,
  UserPen,
  UserPlus,
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
import { agentColor, Face, Spinner } from "../ui/Avatar";
import { IconButton } from "../ui/Button";
import type { ActionKind } from "./actions";
import { type Block, type Segment, toBlocks } from "./blocks";
import { FileCard } from "./Files";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./Question";

const COLUMN = "mx-auto w-full max-w-[820px] px-3 sm:px-5";

export function Thread({
  session,
  name,
  agents,
  empty,
}: {
  session: AgentSession;
  name: string;
  agents: AgentSummary[];
  empty: ReactNode;
}) {
  const thread = session.thread.use();
  const names = useMemo(() => {
    const byId = new Map<string, string>(agents.map((a) => [a.id, a.name]));
    return (id: string) => byId.get(id) ?? "an agent";
  }, [agents]);
  const blocks = useMemo(
    () => toBlocks(thread.items, thread.turns, names),
    [thread.items, thread.turns, names],
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
        <div className="flex justify-center pt-5 pb-2 text-[12px] font-medium text-muted">{dayLabel(block.at)}</div>
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
  if (m.source !== "user") return <Marker message={m} />;
  return (
    <div className="turn group mt-2 flex flex-col items-end gap-0.5">
      {m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {m.attachments.map((f) => (
            <FileCard key={f.path} client={client} file={f} />
          ))}
        </div>
      )}
      {m.answer ? (
        <div className="flex max-w-[80%] items-center gap-2 rounded-[20px] bg-bubble-me px-3.5 py-2 text-[14.5px]">
          <CornerDownRight className="size-3.5 text-faint" />
          {Object.values(m.answer.answers).join(" · ")}
        </div>
      ) : (
        m.text && (
          <div className="max-w-[80%] rounded-[20px] bg-bubble-me px-3.5 py-2 text-[14.5px] leading-[22px] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {m.text}
          </div>
        )
      )}
      <div className="flex h-5 items-center gap-1 text-[11.5px] text-faint">
        {steered && <span>Joined the running turn ·</span>}
        <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 max-sm:hidden">
          {m.text && <CopyButton text={m.text} />}
          {clock(m.at)}
        </span>
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

function Marker({ message: m }: { message: InputMessage }) {
  const [open, setOpen] = useState(false);
  const Icon = m.source === "schedule" ? AlarmClock : m.source === "agent" ? Bot : Info;
  const label =
    m.source === "schedule"
      ? `Routine · ${m.routine ?? "ran"}`
      : m.source === "agent"
        ? `Message from ${m.from?.name ?? "an agent"}`
        : "System note";
  return (
    <div className="turn my-3 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => m.text && setOpen(!open)}
        className="flex h-6 items-center gap-1.5 rounded-full px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <Icon className="size-3.5" />
        <span className="font-medium">{label}</span>
        <span className="text-faint">{clock(m.at)}</span>
      </button>
      {open && m.text && (
        <div className="animate-in max-w-[80%] rounded-[16px] border border-line px-3.5 py-2 text-[13px] whitespace-pre-wrap text-muted">{m.text}</div>
      )}
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
    <div className="turn group mt-2 flex flex-col items-start gap-1.5">
      {segments.map((s) => (
        <SegmentView key={s.key} client={client} segment={s} />
      ))}
      {text && (
        <div className="-mt-1 flex h-5 items-center gap-1 pl-1 text-[11.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100 max-sm:hidden">
          <CopyButton text={text} />
          {name}
        </div>
      )}
    </div>
  );
}

function SegmentView({ client, segment: s }: { client: AgentClient; segment: Segment }) {
  switch (s.kind) {
    case "text":
      return (
        <Bubble>
          <Markdown text={s.text} />
        </Bubble>
      );
    case "action":
      return <ActionChip kind={s.action.kind} text={s.action.text} />;
    case "ask":
      return <QuestionCard client={client} ask={s.ask} />;
    case "file":
      return <FileCard client={client} file={s.file} caption={s.file.caption} />;
    case "error":
      return (
        <div className="flex max-w-[88%] items-start gap-2 rounded-[16px] bg-danger/10 px-3.5 py-2 text-[13px] text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {s.text}
        </div>
      );
  }
}

const ACTION_ICONS: Record<ActionKind, LucideIcon> = {
  agent: UserPlus,
  message: Send,
  stop: Square,
  routine: AlarmClock,
  memory: Brain,
  profile: UserPen,
};

function ActionChip({ kind, text }: { kind: ActionKind; text: string }) {
  const Icon = ACTION_ICONS[kind];
  return (
    <div className="flex h-7 max-w-[88%] items-center gap-1.5 rounded-full border border-line px-2.5 text-[12.5px] text-muted">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
}

function Bubble({ children }: { children: ReactNode }) {
  return <div className="max-w-[88%] min-w-0 rounded-[20px] bg-bubble px-3.5 py-2 text-[14.5px]">{children}</div>;
}

const humanize = (name: string) => {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};

function Live({ session }: { session: AgentSession }) {
  const live = session.live.use();
  if (!live.active) return null;
  const step = live.tools.at(-1);
  const label = step ? "Working" : "Thinking";
  return (
    <div className="mt-3 flex items-start">
      <div
        title={step ? humanize(step.name) : undefined}
        className="group/live flex h-9 items-center gap-2 rounded-[20px] bg-bubble pr-3.5 pl-2"
      >
        <Face color={agentColor(session.id)} size={20} activity="working" />
        <span className="shimmer-text text-[13.5px] font-medium">{label}</span>
        {step && (
          <span className="max-w-0 overflow-hidden text-[12.5px] whitespace-nowrap text-faint transition-[max-width] duration-300 group-hover/live:max-w-[240px]">
            · {humanize(step.name)}
          </span>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : "Copy"}
      size="sm"
      className="size-6"
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

