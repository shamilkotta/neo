import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import type { Attachment, AttachmentInput, Upload } from "@neo/client";
import { ulid } from "../ids";
import { baseName, type Vfs, VfsError, type VfsStat } from "../vfs/vfs";
export type { Attachment, AttachmentInput, Upload } from "@neo/client";

export const ATTACHMENTS_ROOT = "/attachments";
export const USER_ROOT = "/user";
export const STAGING_ROOT = `${USER_ROOT}/.staging`;
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENTS_SIZE = 256 * 1024 * 1024;

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeOf(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && TYPES[ext]) || "application/octet-stream";
}

export function safeName(name: string): string {
  const clean = name
    .replace(/[/\\\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return clean || "file";
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export class AttachmentError extends Error {}

export async function stageUpload(
  vfs: Vfs,
  name: string,
  body: ReadableStream<Uint8Array>,
): Promise<Upload> {
  const id = ulid();
  const stat = await vfs.writeStream(
    `${STAGING_ROOT}/${id}/${safeName(name)}`,
    body,
    { createParents: true, maxBytes: MAX_ATTACHMENTS_SIZE },
  );
  return { id, name: baseName(stat.path), size: stat.size };
}

export async function placeUploads(
  vfs: Vfs,
  inputs: AttachmentInput[],
): Promise<Attachment[]> {
  if (inputs.length > MAX_ATTACHMENTS)
    throw new AttachmentError(`A message attaches at most ${MAX_ATTACHMENTS} files`);
  const sources: Source[] = [];
  for (const input of inputs) {
    const id = input?.id;
    if (typeof id !== "string" || !/^[0-9A-Z]{26}$/.test(id))
      throw new AttachmentError("Each attachment needs an upload id");
    const [file] = await vfs
      .readdir(`${STAGING_ROOT}/${id}`, { limit: 2 })
      .catch((e) => {
        if (e instanceof VfsError && e.code === "not_found") return [];
        throw e;
      });
    if (!file || file.kind !== "file")
      throw new AttachmentError(`No upload ${id} (uploads expire after a day)`);
    sources.push({ stat: file, mimeType: input.mimeType });
  }
  const placed = await place(vfs, sources, ulid(), true);
  for (const input of inputs)
    await vfs.rm(`${STAGING_ROOT}/${input.id}`, { recursive: true }).catch(() => {});
  return placed;
}

export async function placeOutgoing(
  vfs: Vfs,
  path: string,
  callId: string,
  name?: string,
): Promise<Attachment> {
  const stat = await vfs.stat(path).catch((e) => {
    if (e instanceof VfsError && e.code === "not_found")
      throw new AttachmentError(`No file at ${path}`);
    throw e;
  });
  if (stat.kind !== "file") throw new AttachmentError(`${path} is not a file`);
  const [placed] = await place(
    vfs,
    [{ stat, name }],
    `out-${callId.replace(/[^\w-]/g, "_").slice(0, 80)}`,
    false,
  );
  return placed!;
}

interface Source {
  stat: VfsStat;
  name?: string;
  mimeType?: string;
}

async function place(
  vfs: Vfs,
  sources: Source[],
  folderId: string,
  move: boolean,
): Promise<Attachment[]> {
  const total = sources.reduce((n, s) => n + s.stat.size, 0);
  if (total > MAX_ATTACHMENTS_SIZE)
    throw new AttachmentError(
      `The attachments are ${mb(total)}; a message attaches at most ${mb(MAX_ATTACHMENTS_SIZE)}`,
    );
  const folder = `${ATTACHMENTS_ROOT}/${folderId}`;
  await vfs.mkdir(folder, { recursive: true });
  const taken = new Set<string>();
  const placed: Attachment[] = [];
  for (const { stat, name: given, mimeType: claimed } of sources) {
    const name = uniqueName(safeName(given || baseName(stat.path)), taken);
    const path = `${folder}/${name}`;
    if (move) await vfs.rename(stat.path, path);
    else await vfs.copyFile(stat.path, path);
    const type = claimed?.trim().toLowerCase();
    const mimeType = await sniffedType(
      vfs,
      path,
      type && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : mimeTypeOf(name),
    );
    placed.push({ path, name, mimeType, size: stat.size });
  }
  return placed;
}

export async function sweepStaging(vfs: Vfs, now: number): Promise<void> {
  if (!(await vfs.exists(STAGING_ROOT))) return;
  for (const entry of await vfs.readdir(STAGING_ROOT, { limit: 1000 }))
    if (now - entry.mtimeMs > STAGING_TTL_MS)
      await vfs.rm(entry.path, { recursive: true }).catch(() => {});
}

export function attachmentsBlock(
  attachments: Attachment[],
  inline: Set<string>,
  notes: Map<string, string>,
): string {
  const lines = attachments.map((a) => {
    const note = inline.has(a.path)
      ? "shown to you below"
      : notes.get(a.path);
    return `${a.path} (${a.mimeType}, ${size(a.size)}${note ? `; ${note}` : ""})`;
  });
  return `<attachments>\n${lines.join("\n")}\n</attachments>`;
}

export async function inlineCheck(
  vfs: Vfs,
  attachment: Attachment,
  vision: boolean,
): Promise<{ inline: true } | { inline: false; note?: string }> {
  if (!attachment.mimeType.startsWith("image/")) return { inline: false };
  const readIt = "read it with the read tool";
  if (!vision)
    return { inline: false, note: "the current model cannot see images" };
  if (!INLINE_TYPES.has(attachment.mimeType))
    return { inline: false, note: `not shown: ${attachment.mimeType} cannot be sent inline` };
  if (Math.ceil(attachment.size / 3) * 4 > DEFAULT_IMAGE_LIMITS.maxBytes)
    return {
      inline: false,
      note: `not shown: too large to send (${size(attachment.size)}); ${readIt} or process it with the shell`,
    };
  const file = await vfs.open(attachment.path);
  const dims = imageSize(await file.read(0, Math.min(file.stat.size, 256 * 1024)));
  if (!dims)
    return { inline: false, note: `not shown: its size cannot be read; ${readIt}` };
  if (dims.width > DEFAULT_IMAGE_LIMITS.maxWidth || dims.height > DEFAULT_IMAGE_LIMITS.maxHeight)
    return {
      inline: false,
      note: `not shown: ${dims.width}x${dims.height} is larger than ${DEFAULT_IMAGE_LIMITS.maxWidth}x${DEFAULT_IMAGE_LIMITS.maxHeight}`,
    };
  return { inline: true };
}

export function imageSize(
  b: Uint8Array,
): { width: number; height: number } | undefined {
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const tag = (i: number, s: string) =>
    [...s].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b.length >= 24 && b[0] === 0x89 && tag(1, "PNG"))
    return { width: u32(16), height: u32(20) };
  if (b.length >= 10 && tag(0, "GIF8"))
    return { width: le16(6), height: le16(8) };
  if (b.length >= 30 && tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8 "))
      return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (tag(12, "VP8L")) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (tag(12, "VP8X"))
      return {
        width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1,
        height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1,
      };
    return undefined;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: u16(i + 7), height: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
  }
  return undefined;
}

async function sniffedType(vfs: Vfs, path: string, claimed: string): Promise<string> {
  if (!claimed.startsWith("image/")) return claimed;
  const file = await vfs.open(path);
  const head = await file.read(0, 16);
  const tag = (i: number, s: string) =>
    [...s].every((c, j) => head[i + j] === c.charCodeAt(0));
  if (head[0] === 0x89 && tag(1, "PNG")) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (tag(0, "GIF8")) return "image/gif";
  if (tag(0, "RIFF") && tag(8, "WEBP")) return "image/webp";
  return INLINE_TYPES.has(claimed) ? "application/octet-stream" : claimed;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
