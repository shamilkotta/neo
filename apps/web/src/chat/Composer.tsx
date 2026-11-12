import { NeoApiError } from "@neo/client";
import { ArrowUp, FileText, ImagePlus, Plus, Square, Upload, X } from "lucide-react";
import {
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentSession } from "../state/agent";
import { bytes, errorText } from "../lib/format";
import { attempt, toast } from "../lib/toast";
import { Spinner } from "../ui/Avatar";

export interface ComposerHandle {
  focus: () => void;
  fill: (text: string) => void;
  add: (files: FileList | File[]) => void;
}

const draftKey = (id: string) => `neo.draft:${id}`;
const MAX_FILES = 10;

export const Composer = forwardRef<
  ComposerHandle,
  {
    session: AgentSession;
    name: string;
    onNeedsSetup: () => void;
  }
>(function Composer({ session, name, onNeedsSetup }, ref) {
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey(session.id)) ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const state = session.state.use();
  const running = !!state?.turn;
  const paused = state?.state === "active" && state.agent.paused;

  const add = (list: FileList | File[] | null) => {
    if (!list?.length) return;
    setFiles((f) => {
      const next = [...f, ...Array.from(list)];
      if (next.length > MAX_FILES) toast(`Up to ${MAX_FILES} files per message`);
      return next.slice(0, MAX_FILES);
    });
    input.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    fill: (t) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = input.current;
        el?.focus();
        el?.setSelectionRange(t.length, t.length);
      });
    },
    add,
  }));

  useEffect(() => {
    const id = setTimeout(() => {
      if (text) sessionStorage.setItem(draftKey(session.id), text);
      else sessionStorage.removeItem(draftKey(session.id));
    }, 300);
    return () => clearTimeout(id);
  }, [text, session.id]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const empty = !text.trim() && files.length === 0;

  const submit = async () => {
    const value = text.trim();
    if (empty || sending) return;
    setSending(true);
    try {
      const attachments = [];
      for (const file of files) attachments.push(await session.client.upload(file, file.name || "file"));
      await session.client.send(value, {
        clientId: `web-${crypto.randomUUID()}`,
        ...(attachments.length ? { attachments } : {}),
      });
      setText("");
      setFiles([]);
      if (running) toast("Queued — Neo will get to it after this turn");
    } catch (err) {
      if (err instanceof NeoApiError && err.body.setup === true) onNeedsSetup();
      toast(errorText(err), "error");
    } finally {
      setSending(false);
      session.soon();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape" && running && empty) void attempt(() => session.client.stop().then(session.refresh));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      add(e.clipboardData.files);
    }
  };

  const stop = () => void attempt(() => session.client.stop().then(session.refresh));
  return (
    <div className="mx-auto w-full max-w-[820px] px-3 pb-[max(10px,env(safe-area-inset-bottom))] sm:px-5 sm:pb-4">
      <div className="rounded-[22px] border border-line-strong bg-raised transition-[border-color,box-shadow] focus-within:border-[color-mix(in_srgb,var(--brand)_45%,transparent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_14%,transparent)]">
        {files.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {files.map((f, i) => (
              <Pending key={`${f.name}-${f.size}-${i}`} file={f} busy={sending} onRemove={() => setFiles((all) => all.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1 p-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={sending}
            onClick={() => picker.current?.click()}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <Plus className="size-[18px]" />
          </button>
          <textarea
            ref={input}
            rows={1}
            value={text}
            aria-label={`Message ${name}`}
            autoFocus={!matchMedia("(pointer: coarse)").matches}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={paused ? `${name} is paused, messages will wait` : running ? "Queue a follow-up…" : `Message ${name}`}
            className="block max-h-[280px] min-h-8 flex-1 resize-none bg-transparent px-1.5 py-[5px] text-[14.5px] leading-[22px] outline-none placeholder:text-faint focus-visible:outline-none"
          />
          {running && empty ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={stop}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-transform active:scale-90"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={running ? "Queue" : "Send"}
              title={running ? "Queue" : "Send"}
              disabled={empty || sending}
              onClick={() => void submit()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-[transform,opacity] active:scale-90 disabled:opacity-20"
            >
              {sending ? <Spinner /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function Pending({ file, busy, onRemove }: { file: File; busy: boolean; onRemove: () => void }) {
  const url = useMemo(() => (file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div className="group relative shrink-0">
      {url ? (
        <img src={url} alt={file.name} className="size-16 rounded-xl border border-line object-cover" />
      ) : (
        <div className="flex h-16 w-44 items-center gap-2 rounded-xl border border-line bg-sunken px-2.5">
          <FileText className="size-5 shrink-0 text-brand" />
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium">{file.name}</div>
            <div className="text-[11.5px] text-muted">{bytes(file.size)}</div>
          </div>
        </div>
      )}
      {busy ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/30 text-white">
          <Spinner />
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 shadow transition-opacity group-hover:opacity-100 max-sm:opacity-100"
        >
          <X className="size-3" strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="animate-in pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-brand/50 bg-bg/85 backdrop-blur-sm">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-brand/10 text-brand">
        <Upload className="size-6" />
      </div>
      <div className="text-[15px] font-semibold">Drop files to attach</div>
      <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
        <ImagePlus className="size-3.5" /> Images, documents, anything up to 10 files
      </div>
    </div>
  );
}
