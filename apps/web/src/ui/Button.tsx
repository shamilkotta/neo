import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "../lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90 shadow-sm",
  secondary:
    "bg-raised text-fg border border-line hover:bg-hover hover:border-line-strong shadow-[0_1px_0_var(--line)]",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  danger:
    "bg-danger/10 text-danger hover:bg-danger/15 border border-danger/20",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-lg",
  md: "h-9 px-3.5 text-[13.5px] gap-2 rounded-[10px]",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
    icon?: ReactNode;
  }
>(function Button(
  { variant = "secondary", size = "md", icon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background,opacity,border,color] duration-150 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    size?: "sm" | "md";
    active?: boolean;
  }
>(function IconButton(
  { label, size = "md", active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-7" : "size-8",
        active && "bg-hover text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
});
