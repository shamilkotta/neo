import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface BlobStore {
  put(key: string, body: ReadableStream<Uint8Array>): Promise<void>;
  get(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function checkBlobKey(key: string): void {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key))
    throw new Error(`Bad blob key: ${key}`);
}

export function measured(
  stream: ReadableStream<Uint8Array>,
  max: number,
  tooLarge: () => Error,
): {
  stream: ReadableStream<Uint8Array>;
  result(): { size: number; hash: string };
} {
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
