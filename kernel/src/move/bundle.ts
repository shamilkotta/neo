import {
  fromBase64,
  open,
  PASSPHRASE_ITERATIONS,
  passphraseKey,
  randomBytes,
  seal,
  toBase64,
} from "../crypto";
import type { SnapshotRecord } from "./snapshot";

export const BUNDLE_FORMAT = "neo-bundle";
export const BUNDLE_VERSION = 1;
export const BLOB_PIECE = 512 * 1024;

export interface BundleHeader {
  t: typeof BUNDLE_FORMAT;
  version: number;
  instanceId: string;
  epoch: number;
  createdAt: number;
  source: { host: string };
  dek?: {
    kdf: "pbkdf2-sha256";
    iterations: number;
    salt: string;
    sealed: string;
  };
}

export type BundleRecord =
  | SnapshotRecord
  | BundleHeader
  | { t: "blob"; key: string; size: number; hash: string }
  | { t: "blob-data"; data: string }
  | { t: "blob-end" }
  | { t: "end"; records: number };

export class BundleError extends Error {}

export async function wrapDek(
  dek: Uint8Array,
  passphrase: string,
): Promise<NonNullable<BundleHeader["dek"]>> {
  const salt = randomBytes(16);
  const key = await passphraseKey(passphrase, salt, PASSPHRASE_ITERATIONS);
  return {
    kdf: "pbkdf2-sha256",
    iterations: PASSPHRASE_ITERATIONS,
    salt: toBase64(salt),
    sealed: await seal(key, dek, "neo-bundle-dek"),
  };
}

export async function unwrapDek(
  dek: NonNullable<BundleHeader["dek"]>,
  passphrase: string,
): Promise<Uint8Array> {
  const key = await passphraseKey(
    passphrase,
    fromBase64(dek.salt),
    dek.iterations,
  );
  try {
    return await open(key, dek.sealed, "neo-bundle-dek");
  } catch {
    throw new BundleError("Wrong passphrase for this bundle");
  }
}

export function encodeBundle(
  records: AsyncIterable<BundleRecord>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = records[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  }).pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >,
  );
}

export async function* decodeBundle(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<BundleRecord> {
  const stream = body.pipeThrough(
    new DecompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >,
  );
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield JSON.parse(line) as BundleRecord;
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new BundleError(`The bundle is damaged (${error.message})`);
    throw error;
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer) as BundleRecord;
}

export async function readBundle(records: AsyncIterator<BundleRecord>) {
  const first = await records.next().catch(() => ({ done: true, value: undefined }));
  const header = first.value as BundleHeader | undefined;
  if (first.done || header?.t !== BUNDLE_FORMAT)
    throw new BundleError("Not a Neo bundle");
  if (header.version !== BUNDLE_VERSION)
    throw new BundleError(
      `Bundle version ${header.version} is not supported (this Neo reads ${BUNDLE_VERSION})`,
    );
  let pending: BundleRecord | undefined;
  let end: { records: number } | undefined;
  let count = 0;
  const next = async (): Promise<BundleRecord | undefined> => {
    if (pending) {
      const value = pending;
      pending = undefined;
      return value;
    }
    const step = await records.next();
    return step.done ? undefined : step.value;
  };
  return {
    header,
    async *main(): AsyncGenerator<SnapshotRecord> {
      for (let record = await next(); record; record = await next()) {
        if (record.t === "end" || record.t === "blob") {
          pending = record;
          return;
        }
        if (record.t !== "schema" && record.t !== "rows")
          throw new BundleError("The bundle is damaged (unexpected record)");
        count++;
        yield record;
      }
    },
    async *blobs(): AsyncGenerator<{
      key: string;
      size: number;
      hash: string;
      stream: ReadableStream<Uint8Array>;
    }> {
      for (let record = await next(); record; record = await next()) {
        if (record.t !== "blob") {
          pending = record;
          return;
        }
        count++;
        let finished = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const piece = await next();
            if (piece) count++;
            if (!piece || piece.t === "blob-end") {
              finished = true;
              return piece
                ? controller.close()
                : controller.error(
                    new BundleError("The bundle is truncated (a file is cut off)"),
                  );
            }
            if (piece.t !== "blob-data")
              return controller.error(
                new BundleError("The bundle is damaged (a file is cut off)"),
              );
            controller.enqueue(fromBase64(piece.data));
          },
        });
        yield { key: record.key, size: record.size, hash: record.hash, stream };
        if (!finished) throw new Error("Each blob must be read to its end");
      }
    },
    async end(): Promise<void> {
      const record = await next();
      if (record?.t === "end") end = record;
      if (!end) throw new BundleError("The bundle is truncated (no end record)");
      if (end.records !== count)
        throw new BundleError(
          `The bundle is damaged: ${count} records, expected ${end.records}`,
        );
    },
  };
}
