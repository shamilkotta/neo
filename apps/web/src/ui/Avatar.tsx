import { cn, hue } from "../lib/format";

export type Activity = "working" | "paused" | "idle";

export function Face({
  color,
  size,
  activity,
  className,
}: {
  color: string;
  size: number;
  activity?: Activity;
  className?: string;
}) {
  const working = activity === "working";
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      aria-hidden
      className={cn(
        "shrink-0",
        activity === "paused" && "opacity-55 grayscale",
        className,
      )}
    >
      <g transform="rotate(-8 20 20)">
        <rect x="2" y="2" width="36" height="36" rx="13" fill={color} />
        <g
          className={working ? "animate-look" : undefined}
          style={{ transformOrigin: "20px 20px" }}
        >
          {[14, 26].map((x) => (
            <g
              key={x}
              className="animate-blink"
              style={{
                transformOrigin: `${x}px 19px`,
                transformBox: "view-box",
              }}
            >
              <ellipse cx={x} cy="19" rx="3.4" ry="4.6" fill="#0a0a0c" />
              <circle cx={x + 1.2} cy="17.2" r="1.2" fill="#fff" />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

export const agentColor = (id: string) => `oklch(0.78 0.11 ${hue(id)})`;

export function Avatar({
  id,
  size = 28,
  activity,
  className,
}: {
  id: string;
  name?: string;
  size?: number;
  activity?: Activity;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <Face color={agentColor(id)} size={size} activity={activity} />
      {activity === "working" && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-ok ring-2 ring-panel">
          <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" />
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
