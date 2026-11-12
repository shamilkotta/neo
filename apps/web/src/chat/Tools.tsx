import {
  AlarmClock,
  Brain,
  Check,
  ChevronRight,
  FilePen,
  FileSearch,
  Globe,
  type LucideIcon,
  MessagesSquare,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { cn } from "../lib/format";
import { Spinner } from "../ui/Avatar";

const ICONS: [RegExp, LucideIcon][] = [
  [/schedul|routine|remind|heartbeat/, AlarmClock],
  [/memor|remember|recall/, Brain],
  [/search|grep|find|glob/, Search],
  [/read|list|ls|view/, FileSearch],
  [/write|edit|patch|create|delete|file/, FilePen],
  [/fetch|http|web|browse|url/, Globe],
  [/bash|exec|shell|run|command/, Terminal],
  [/agent|message|send|ask/, MessagesSquare],
];

const iconFor = (name: string) =>
  ICONS.find(([re]) => re.test(name))?.[1] ?? Wrench;

export const humanize = (name: string) => {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};

const KEYS = ["path", "file", "query", "pattern", "url", "command", "cmd", "name", "to", "text", "prompt"];

export function summarize(args: unknown) {
  if (!args || typeof args !== "object") return typeof args === "string" ? args : "";
  const record = args as Record<string, unknown>;
  for (const key of KEYS)
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  const first = Object.values(record).find((v) => typeof v === "string");
  if (typeof first === "string") return first;
  return Object.entries(record)
    .filter(([, v]) => typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

export const ToolRow = memo(function ToolRow({
  name,
  args,
  output,
  state,
}: {
  name: string;
  args?: unknown;
  output?: string;
  state: "running" | "done" | "error";
}) {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(name.toLowerCase());
  const detail = summarize(args).split("\n")[0]!.slice(0, 120);
  const hasBody = !!output || hasArgs(args);
  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-left text-muted transition-colors",
          hasBody && "hover:bg-hover hover:text-fg",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {state === "running" ? (
            <Spinner className="size-3 text-brand" />
          ) : (
            <Icon className={cn("size-3.5", state === "error" && "text-danger")} />
          )}
        </span>
        <span className={cn("shrink-0 font-medium", state === "running" && "shimmer-text")}>
          {humanize(name)}
        </span>
        {detail && <span className="min-w-0 truncate font-mono text-[12px] text-faint">{detail}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {state === "error" && <TriangleAlert className="size-3.5 text-danger" />}
          {hasBody && (
            <ChevronRight
              className={cn("size-3.5 text-faint opacity-0 transition-all group-hover:opacity-100", open && "rotate-90 opacity-100")}
            />
          )}
        </span>
      </button>
      {open && (
        <div className="animate-in mt-1 mb-2 ml-7 overflow-hidden rounded-xl border border-line bg-sunken">
          {hasArgs(args) && (
            <pre className="max-h-60 overflow-auto border-b border-line px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
          {output && (
            <pre className={cn("max-h-80 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap", state === "error" && "text-danger")}>
              {output.length > 20000 ? `${output.slice(0, 20000)}\n…` : output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

export function ToolCard({
  children,
  count,
  running,
  failed,
}: {
  children: ReactNode[];
  count: number;
  running: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = open || running;
  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[14px] border border-line-strong">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={shown}
        className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors hover:bg-hover"
      >
        {running ? (
          <Spinner className="size-3.5 text-brand" />
        ) : failed ? (
          <TriangleAlert className="size-4 text-danger" />
        ) : (
          <span className="flex size-4 items-center justify-center rounded-full bg-muted/25">
            <Check className="size-2.5 text-fg" strokeWidth={3} />
          </span>
        )}
        <span className={cn("flex-1 font-medium", running && "shimmer-text")}>
          {running ? "Working" : count === 1 ? "Used a tool" : `Used ${count} tools`}
        </span>
        <span className="text-[12px] text-faint tabular-nums">{count}</span>
        <ChevronRight className={cn("size-3.5 text-faint transition-transform", shown && "rotate-90")} />
      </button>
      {shown && <div className="animate-in border-t border-line px-1.5 py-1">{children}</div>}
    </div>
  );
}

const hasArgs = (args: unknown) => typeof args === "object" && args !== null && Object.keys(args).length > 0;
