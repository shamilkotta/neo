import type { MailboxMessage } from "@neo/client";
import { ArrowUp, ChevronDown, CornerDownRight, Paperclip, Pencil, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AgentSession } from "../state/agent";
import { cn } from "../lib/format";
import { attempt } from "../lib/toast";
import { IconButton } from "../ui/Button";

export function Queue({ session }: { session: AgentSession }) {
  const all = session.queue.use();
  const pending = session.pending.use();
  const queue = all.filter((m) => !pending.some((p) => p.id === m.id));
  const state = session.state.use();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  if (queue.length === 0) return null;
  const running = !!state?.turn;
  const act = (fn: () => Promise<unknown>) => void attempt(fn).then(session.refresh);
  return (
    <div className="mx-auto w-full max-w-[760px] px-3 sm:px-6">
      <div className="animate-up -mb-px overflow-hidden rounded-t-2xl border border-b-0 border-line bg-panel">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-4 py-2 text-[12.5px] font-medium text-muted hover:text-fg"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-brand/12 text-[11px] font-semibold text-brand">
            {queue.length}
          </span>
          Queued {queue.length === 1 ? "message" : "messages"}
          <ChevronDown className={cn("ml-auto size-4 transition-transform", !open && "-rotate-90")} />
        </button>
        {open && (
          <div className="flex max-h-48 flex-col overflow-y-auto px-2 pb-2">
            {queue.map((m, n) => (
              <Row
                key={m.id}
                message={m}
                editing={editing === m.id}
                onEdit={() => setEditing(m.id)}
                onSave={(text) => {
                  setEditing(null);
                  if (text && text !== m.text) act(() => session.client.editQueued(m.id, text));
                }}
                actions={
                  <>
                    {running && (
                      <IconButton label="Add to the running turn" size="sm" onClick={() => act(() => session.client.steerQueued(m.id))}>
                        <CornerDownRight className="size-3.5" />
                      </IconButton>
                    )}
                    {n > 0 && (
                      <IconButton
                        label="Move up"
                        size="sm"
                        onClick={() =>
                          act(() => {
                            const ids = queue.map((q) => q.id);
                            ids.splice(n - 1, 0, ...ids.splice(n, 1));
                            return session.client.reorderQueue(ids);
                          })
                        }
                      >
                        <ArrowUp className="size-3.5" />
                      </IconButton>
                    )}
                    <IconButton label="Edit" size="sm" onClick={() => setEditing(m.id)}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                    <IconButton label="Remove" size="sm" onClick={() => act(() => session.client.cancelQueued(m.id))}>
                      <X className="size-3.5" />
                    </IconButton>
                  </>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  message: m,
  editing,
  onEdit,
  onSave,
  actions,
}: {
  message: MailboxMessage;
  editing: boolean;
  onEdit: () => void;
  onSave: (text: string) => void;
  actions: ReactNode;
}) {
  const [value, setValue] = useState(m.text);
  if (editing)
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onSave(value.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(value.trim());
          if (e.key === "Escape") onSave(m.text);
        }}
        className="my-0.5 h-8 rounded-lg border border-brand/40 bg-raised px-2.5 text-[13px] outline-none"
      />
    );
  return (
    <div className="group flex items-center gap-2 rounded-lg py-0.5 pr-0.5 pl-2.5 hover:bg-hover">
      {m.attachments.length > 0 && (
        <span className="flex items-center gap-0.5 text-[11.5px] text-faint">
          <Paperclip className="size-3" />
          {m.attachments.length}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]" title={m.text} onDoubleClick={onEdit}>
        {m.text || "Attachment"}
      </span>
      <span className="flex shrink-0 opacity-60 transition-opacity group-hover:opacity-100">{actions}</span>
    </div>
  );
}
