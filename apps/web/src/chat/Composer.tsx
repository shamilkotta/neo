import { NeoApiError } from "@neo/client";
import { ArrowUp, FileText, ImagePlus, Paperclip, Square, Upload, X } from "lucide-react";
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
import { bytes, cn, errorText } from "../lib/format";
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
    model?: string;
    onNeedsSetup: () => void;
    onModel: () => void;
  }
>(function Composer({ session, name, model, onNeedsSetup, onModel }, ref) {
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

  return (
    <div className="mx-auto w-full max-w-[760px] px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
      <div
        className={cn(
          "rounded-[24px] border border-line-strong bg-raised shadow-[0_8px_30px_-12px_rgb(0_0_0/0.18)] transition-[border,box-shadow] focus-within:border-brand/40 focus-within:shadow-[0_8px_30px_-10px_rgb(0_0_0/0.22),0_0_0_4px_color-mix(in_srgb,var(--brand)_10%,transparent)] dark:shadow-none",
        )}
      >
        {files.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {files.map((f, i) => (
              <Pending key={`${f.name}-${f.size}-${i}`} file={f} busy={sending} onRemove={() => setFiles((all) => all.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <textarea
          ref={input}
          rows={1}
          value={text}
          autoFocus={!matchMedia("(pointer: coarse)").matches}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={paused ? `${name} is paused — messages wait in the queue` : running ? "Add to the queue…" : `Message ${name}`}
          className="block max-h-[280px] w-full resize-none bg-transparent focus-visible:outline-none px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
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
            title="Attach files"
            disabled={sending}
            onClick={() => picker.current?.click()}
            className="flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <Paperclip className="size-[18px]" />
          </button>
          <button
            type="button"
            onClick={onModel}
            className="flex h-8 max-w-[50%] items-center gap-1.5 truncate rounded-full px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", model ? "bg-ok" : "bg-warn")} />
            <span className="truncate">{model ?? "Choose a model"}</span>
          </button>
          <span className="flex-1" />
          {running && empty ? (
            <button
              type="button"
              title="Stop (Esc)"
              onClick={() => void attempt(() => session.client.stop().then(session.refresh))}
              className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-fg transition-transform active:scale-90"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              title={running ? "Queue" : "Send"}
              disabled={empty || sending}
              onClick={() => void submit()}
              className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-fg transition-[transform,opacity] active:scale-90 disabled:opacity-25"
            >
              {sending ? <Spinner /> : <ArrowUp className="size-[18px]" strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 hidden text-center text-[11.5px] text-faint sm:block">
        Enter to send · Shift+Enter for a new line{running ? " · Esc to stop" : ""}
      </p>
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
