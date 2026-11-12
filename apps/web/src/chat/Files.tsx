import type { AgentClient, Attachment } from "@neo/client";
import { Download, FileText, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { bytes, cn } from "../lib/format";
import { attempt } from "../lib/toast";
import { IconButton } from "../ui/Button";

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
const PREVIEW_MAX = 20 * 1024 * 1024;
export const isImage = (f: { mimeType: string; size: number }) =>
  IMAGE.test(f.mimeType) && f.size <= PREVIEW_MAX;

const blobs = new Map<string, Promise<string>>();

function useBlobUrl(client: AgentClient, path: string, enabled: boolean) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    let pending = blobs.get(path);
    if (!pending) {
      pending = client.fileBlob(path).then((b) => URL.createObjectURL(b));
      pending.catch(() => blobs.delete(path));
      blobs.set(path, pending);
    }
    pending.then((u) => !gone && setUrl(u)).catch(() => {});
    return () => {
      gone = true;
    };
  }, [client, path, enabled]);
  return url;
}

async function download(client: AgentClient, file: Attachment) {
  await attempt(async () => {
    const href = URL.createObjectURL(await client.fileBlob(file.path));
    const a = document.createElement("a");
    a.href = href;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  });
}

const ext = (name: string) =>
  name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";

export const FileCard = memo(function FileCard({
  client,
  file,
  caption,
}: {
  client: AgentClient;
  file: Attachment;
  caption?: string | null;
}) {
  const image = isImage(file);
  const url = useBlobUrl(client, file.path, image);
  const [zoom, setZoom] = useState(false);
  if (image)
    return (
      <figure className="group relative max-w-[min(100%,360px)]">
        <button
          type="button"
          onClick={() => setZoom(true)}
          className={cn(
            "block overflow-hidden rounded-xl border border-line bg-sunken",
            !url && "h-48 w-64 animate-pulse",
          )}
        >
          {url && (
            <img
              src={url}
              alt={file.name}
              className="max-h-80 w-auto object-contain transition-transform duration-300 group-hover:scale-[1.015]"
            />
          )}
        </button>
        <IconButton
          label="Download"
          size="sm"
          onClick={() => void download(client, file)}
          className="absolute top-2 right-2 bg-black/50 text-white opacity-0 backdrop-blur group-hover:opacity-100 hover:bg-black/70 hover:text-white"
        >
          <Download className="size-3.5" />
        </IconButton>
        {caption && (
          <figcaption className="mt-1.5 text-[12.5px] text-muted">
            {caption}
          </figcaption>
        )}
        {zoom && url && (
          <Lightbox url={url} name={file.name} onClose={() => setZoom(false)} />
        )}
      </figure>
    );
  return (
    <div className="flex max-w-sm flex-col gap-1">
      <button
        type="button"
        onClick={() => void download(client, file)}
        className="group flex items-center gap-3 rounded-xl border border-line bg-raised p-2.5 pr-3.5 text-left transition-colors hover:border-line-strong"
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <FileText className="size-5" />
          <span className="absolute -bottom-1 rounded bg-brand px-1 text-[8.5px] font-bold text-white">
            {ext(file.name)}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium" title={file.path}>
            {file.name}
          </span>
          <span className="block text-[12px] text-muted">{bytes(file.size)}</span>
        </span>
        <Download className="size-4 text-faint transition-colors group-hover:text-fg" />
      </button>
      {caption && <span className="text-[12.5px] text-muted">{caption}</span>}
    </div>
  );
});

function Lightbox({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="animate-in fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <img src={url} alt={name} className="animate-pop max-h-full max-w-full rounded-lg shadow-2xl" />
      <IconButton
        label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:bg-white/10 hover:text-white"
      >
        <X className="size-5" />
      </IconButton>
    </div>,
    document.body,
  );
}
