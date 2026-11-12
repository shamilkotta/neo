import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "../lib/format";
import { dismiss, toasts } from "../lib/toast";

const ICON = {
  info: <Info className="size-4 text-muted" />,
  success: <CircleCheck className="size-4 text-ok" />,
  error: <CircleAlert className="size-4 text-danger" />,
};

export function Toaster() {
  const list = toasts.use();
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:right-4 sm:left-auto sm:items-end">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={cn(
            "animate-up pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl border border-line bg-raised py-2.5 pr-2 pl-3 text-[13px] shadow-lg",
          )}
        >
          <span className="mt-0.5">{ICON[t.kind]}</span>
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button
            className="rounded p-0.5 text-faint hover:text-fg"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
