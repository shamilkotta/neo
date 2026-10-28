import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Where the bytes of large files live: a folder on disk (Bun), R2 (Cloudflare). The instance
 * database keeps only each file's key, size and hash, so the database stays small and a file of
 * any size streams in and out. A move copies the bytes through the bundle; keys are this host's
 * own business and never need to match between hosts.
 *
 * Objects are written once and never changed: a new version of a file is a new object.
 */
export interface BlobStore {
  /** Stores a new object from a stream (of unknown length). */
  put(key: string, body: ReadableStream<Uint8Array>): Promise<void>;
  /** An object's bytes, or a range of them; null when it does not exist. */
  get(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object of this host (a failed import starts empty again). */
  clear(): Promise<void>;
}

/** Keys are made by Neo (UUIDs) but also arrive in bundles: never let one name a path. */
export function checkBlobKey(key: string): void {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key))
    throw new Error(`Bad blob key: ${key}`);
}

/**
 * Passes a stream through, counting and hashing it; throws (failing the write) past `max` bytes.
 * `result()` is the size and SHA-256 hex once the stream has been read to the end.
 */
export function measured(
  stream: ReadableStream<Uint8Array>,
  max: number,
  tooLarge: () => Error,
): {
  stream: ReadableStream<Uint8Array>;
  result(): { size: number; hash: string };
} {
  // Incremental: the stream is hashed as it passes, never held whole (Web Crypto cannot do this).
  const hash = sha256.create();
  let size = 0;
  let digest: string | undefined;
  const counted = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > max) throw tooLarge();
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        digest = bytesToHex(hash.digest());
      },
    }),
  );
  return {
    stream: counted,
    result() {
      if (digest === undefined)
        throw new Error("The stream was not read to the end");
      return { size, hash: digest };
    },
  };
}

/** One stream after another. */
export function concatStreams(
  parts: (() => Promise<ReadableStream<Uint8Array>>)[],
): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          const next = parts[index++];
          if (!next) return controller.close();
          reader = (await next()).getReader();
        }
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        reader = undefined;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** `length` zero bytes, a piece at a time. */
export function zeroStream(length: number): ReadableStream<Uint8Array> {
  let left = length;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const n = Math.min(left, 64 * 1024);
      left -= n;
      controller.enqueue(new Uint8Array(n));
    },
  });
}

/** Reads a whole stream (of a known, bounded size) into memory. */
export async function collect(
  stream: ReadableStream<Uint8Array>,
  size?: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) {
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(size ?? total);
  let offset = 0;
  for (const part of parts) {
    out.set(part.subarray(0, out.length - offset), offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return out;
}
