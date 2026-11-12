import { cn, hue, initials } from "../lib/format";

export type Activity = "working" | "paused" | "idle";

export function Avatar({
  id,
  name,
  size = 28,
  activity,
  className,
}: {
  id: string;
  name: string;
  size?: number;
  activity?: Activity;
  className?: string;
}) {
  const h = hue(id);
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <span
        className="flex size-full items-center justify-center rounded-[30%] font-semibold text-white"
        style={{
          fontSize: size * 0.38,
          background: `linear-gradient(135deg, oklch(0.68 0.15 ${h}), oklch(0.52 0.17 ${h + 30}))`,
        }}
      >
        {initials(name)}
      </span>
      {activity && activity !== "idle" && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-panel",
            activity === "working" ? "bg-ok" : "bg-warn",
          )}
        >
          {activity === "working" && (
            <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" />
          )}
        </span>
      )}
    </span>
  );
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-sunken px-1 font-sans text-[11px] text-muted">
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent",
        className,
      )}
    />
  );
}
