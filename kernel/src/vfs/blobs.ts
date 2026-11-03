import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Type } from "typebox";

export type BlobKey = string & { readonly __brand: "BlobKey" };

const BLOB_KEY = "^[A-Za-z0-9-]{8,64}$";

export const isBlobKey = (key: string): key is BlobKey =>
  new RegExp(BLOB_KEY).test(key);

export const BlobKey = Type.Unsafe<BlobKey>(Type.String({ pattern: BLOB_KEY }));

export function newBlobKey() {
  const key = crypto.randomUUID();
  if (!isBlobKey(key)) throw new Error(`Bad blob key: ${key}`);
  return key;
}

export interface BlobStore {
  put(key: BlobKey, body: ReadableStream<Uint8Array>): Promise<void>;
  get(
    key: BlobKey,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: BlobKey): Promise<void>;
  clear(): Promise<void>;
}

export function measured(
  stream: ReadableStream<Uint8Array>,
  max: number,
  tooLarge: () => Error,
) {
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
) {
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

export function bytesStream(bytes: Uint8Array) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function zeroStream(length: number) {
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
) {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream) {
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
