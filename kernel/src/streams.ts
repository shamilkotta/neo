/**
 * Bodies are streamed wherever the bytes can flow through (files, sites, bundles). Some must be
 * whole to be used: a webhook body is checked against its signature, a page goes to a model, a
 * zip needs its central directory. Those are read with a cap, so no sender can make Neo buffer
 * more than the cap: the read stops (and cancels the body) as soon as it would go over.
 */

export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The body is larger than ${limit} bytes`);
  }
}

export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

/** The whole body, up to `limit` bytes; more throws `TooLargeError` unless `truncate` is set. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  options: { truncate?: boolean } = {},
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), truncated: false };
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        if (!options.truncate) throw new TooLargeError(limit);
        parts.push(value.subarray(0, limit - size));
        size = limit;
        truncated = true;
        break;
      }
      parts.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, truncated };
}

/** A request's or response's body as bytes, up to `limit`. */
export async function bytesCapped(
  message: Request | Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(message.headers.get("content-length") ?? NaN);
  if (declared > limit) {
    await message.body?.cancel().catch(() => {});
    throw new TooLargeError(limit);
  }
  return (await readCapped(message.body, limit)).bytes;
}

/** A body as text, up to `limit` bytes. */
export async function textCapped(
  message: Request | Response,
  limit: number,
): Promise<string> {
  return new TextDecoder().decode(await bytesCapped(message, limit));
}

/** A body as JSON, up to `limit` bytes. */
export async function jsonCapped<T = unknown>(
  message: Request | Response,
  limit: number,
): Promise<T> {
  return JSON.parse(await textCapped(message, limit)) as T;
}

/** Common caps. */
export const LIMITS = {
  /** A JSON reply from a service Neo calls. */
  json: 4 * 1024 * 1024,
  /** A JSON request to the API (it may carry small inline attachments; send big files with `PUT /v1/files` and attach them by path). */
  apiJson: 16 * 1024 * 1024,
  /** Audio to transcribe. */
  audio: 25 * 1024 * 1024,
  /** A webhook delivery (signed over the whole body). */
  webhook: 1024 * 1024,
  /** A file a chat platform hands over, or a skill zip. */
  download: 32 * 1024 * 1024,
  /** An error body kept for a message. */
  error: 16 * 1024,
};
