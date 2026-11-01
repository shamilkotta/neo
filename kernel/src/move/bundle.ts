import {
  fromBase64,
  open,
  PASSPHRASE_ITERATIONS,
  passphraseKey,
  randomBytes,
  seal,
  toBase64,
} from "../crypto";
import type { SqliteDatabase } from "../sql";
import { measured, type BlobStore } from "../vfs/blobs";
import { rechunk } from "../vfs/vfs";
import { dumpDatabase, loadDatabase, type SnapshotRecord } from "./snapshot";

// A bundle is gzipped ndjson: a header, then one part per Durable Object (the coordinator first,
// then each agent), then an end record. A part is the DO's database and its blobs; each DO writes
// and reads its own part, so the coordinator only passes agent parts through.
export const BUNDLE_FORMAT = "neo-bundle";
export const BUNDLE_VERSION = 2;
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

export type PartStart = { t: "part"; kind: "coordinator" | "agent"; id?: string };

export type BundleRecord =
  | SnapshotRecord
  | BundleHeader
  | PartStart
  | { t: "blob"; key: string; size: number; hash: string }
  | { t: "blob-data"; data: string }
  | { t: "blob-end" }
  | { t: "part-end"; records: number }
  | { t: "end"; parts: number };

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

export function encodeNdjson(
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
  });
}

export async function* decodeNdjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<BundleRecord> {
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
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as BundleRecord;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new BundleError(`The bundle is damaged (${error.message})`);
    throw error;
  }
}

export const encodeBundle = (records: AsyncIterable<BundleRecord>) =>
  encodeNdjson(records).pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >,
  );

export const decodeBundle = (body: ReadableStream<Uint8Array>) =>
  decodeNdjson(
    body.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    ),
  );

/** One DO's part: its database, then its blobs, then a count. `keep` drops rows (the DEK). */
export async function* writePart(
  db: SqliteDatabase,
  blobs: BlobStore,
  keep?: (table: string, columns: string[], row: unknown[]) => boolean,
): AsyncGenerator<BundleRecord> {
  let count = 0;
  for await (const record of dumpDatabase(db)) {
    if (record.t === "rows" && keep)
      record.rows = record.rows.filter((row) =>
        keep(record.table, record.columns, row),
      );
    count++;
    yield record;
  }
  const hasBlobs = await db.get(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vfs_blobs'`,
  );
  for (let after = ""; hasBlobs; ) {
    const page = await db.all<{ key: string; size: number; hash: string }>(
      `SELECT key, size, hash FROM vfs_blobs WHERE key > ? ORDER BY key LIMIT 100`,
      after,
    );
    if (page.length === 0) break;
    for (const blob of page) {
      const stream = await blobs.get(blob.key);
      if (!stream) throw new Error(`A file's content is missing (${blob.key})`);
      count++;
      yield { t: "blob", ...blob };
      for await (const piece of rechunk(stream, BLOB_PIECE)) {
        count++;
        yield { t: "blob-data", data: toBase64(piece) };
      }
      count++;
      yield { t: "blob-end" };
    }
    after = page.at(-1)!.key;
  }
  yield { t: "part-end", records: count };
}

/** Reads one part (positioned after its start) into an empty database and blob store. */
export async function readPart(
  records: AsyncIterator<BundleRecord>,
  db: SqliteDatabase,
  blobs: BlobStore,
): Promise<void> {
  let pending: BundleRecord | undefined;
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
  async function* main(): AsyncGenerator<SnapshotRecord> {
    for (let record = await next(); record; record = await next()) {
      if (record.t === "part-end" || record.t === "blob") {
        pending = record;
        return;
      }
      if (record.t !== "schema" && record.t !== "rows")
        throw new BundleError("The bundle is damaged (unexpected record)");
      count++;
      yield record;
    }
  }
  await loadDatabase(db, main());
  for (let record = await next(); record; record = await next()) {
    if (record.t !== "blob") {
      pending = record;
      break;
    }
    count++;
    const blob = record;
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
    const body = measured(stream, Number.MAX_SAFE_INTEGER, () => new Error());
    await blobs.put(blob.key, body.stream);
    const got = body.result();
    if (!finished || got.size !== blob.size || got.hash !== blob.hash)
      throw new BundleError(
        `The bundle is damaged: a file's content does not match (${blob.key})`,
      );
  }
  const end = await next();
  if (end?.t !== "part-end")
    throw new BundleError("The bundle is truncated (a part is cut off)");
  if (end.records !== count)
    throw new BundleError(
      `The bundle is damaged: ${count} records, expected ${end.records}`,
    );
}

/** Passes one part's records (up to and including its end) on as a stream for its DO. */
export function forwardPart(
  records: AsyncIterator<BundleRecord>,
): ReadableStream<Uint8Array> {
  let done = false;
  return encodeNdjson({
    async *[Symbol.asyncIterator]() {
      while (!done) {
        const step = await records.next();
        if (step.done)
          throw new BundleError("The bundle is truncated (a part is cut off)");
        if (step.value.t === "part-end") done = true;
        yield step.value;
      }
    },
  });
}

export async function readHeader(
  records: AsyncIterator<BundleRecord>,
): Promise<BundleHeader> {
  const first = await records
    .next()
    .catch(() => ({ done: true as const, value: undefined }));
  const header = first.value as BundleHeader | undefined;
  if (first.done || header?.t !== BUNDLE_FORMAT)
    throw new BundleError("Not a Neo bundle");
  if (header.version !== BUNDLE_VERSION)
    throw new BundleError(
      `Bundle version ${header.version} is not supported (this Neo reads ${BUNDLE_VERSION})`,
    );
  return header;
}
