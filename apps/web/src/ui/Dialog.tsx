import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/format";
import { IconButton } from "./Button";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  bare,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  bare?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => {
      const target =
        panel.current?.querySelector<HTMLElement>("[autofocus]") ??
        panel.current;
      target?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:pt-[12vh]">
      <div
        className="animate-in absolute inset-0 bg-black/40 backdrop-blur-[2px] dark:bg-black/60"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal
        tabIndex={-1}
        className={cn(
          "animate-pop relative max-h-[85dvh] w-full overflow-hidden rounded-t-2xl border border-line bg-raised shadow-2xl outline-none sm:w-[440px] sm:rounded-2xl",
          className,
        )}
      >
        {bare ? (
          children
        ) : (
          <>
            <div className="flex items-start gap-3 px-5 pt-5">
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">{title}</h2>
                {description && (
                  <p className="mt-1 text-[13px] text-muted">{description}</p>
                )}
              </div>
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="px-5 pt-4 pb-5">{children}</div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
