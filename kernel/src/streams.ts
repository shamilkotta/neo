
export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The body is larger than ${limit} bytes`);
  }
}

export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

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

export async function textCapped(
  message: Request | Response,
  limit: number,
): Promise<string> {
  return new TextDecoder().decode(await bytesCapped(message, limit));
}

export async function jsonCapped<T = unknown>(
  message: Request | Response,
  limit: number,
): Promise<T> {
  return JSON.parse(await textCapped(message, limit)) as T;
}

export const LIMITS = {
  json: 4 * 1024 * 1024,
  apiJson: 16 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  webhook: 1024 * 1024,
  download: 32 * 1024 * 1024,
  error: 16 * 1024,
};
