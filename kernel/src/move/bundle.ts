import { Type, type Static } from "typebox";
import Value from "typebox/value";
import { AgentId } from "@neo/client";
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
import { plainBytes, plainChunks } from "../streams";
import { BlobKey, measured, type BlobStore } from "../vfs/blobs";
import { rechunk } from "../vfs/vfs";
import { dumpDatabase, loadDatabase, SnapshotRecord } from "./snapshot";

export const BUNDLE_FORMAT = "neo-bundle";
export const BUNDLE_VERSION = 2;
export const BLOB_PIECE = 512 * 1024;

const WrappedDek = Type.Object({
  kdf: Type.Literal("pbkdf2-sha256"),
  iterations: Type.Number(),
  salt: Type.String(),
  sealed: Type.String(),
});
export type WrappedDek = Static<typeof WrappedDek>;

export const BundleHeader = Type.Object({
  t: Type.Literal(BUNDLE_FORMAT),
  version: Type.Number(),
  instanceId: Type.String(),
  epoch: Type.Number(),
  createdAt: Type.Number(),
  source: Type.Object({ host: Type.String() }),
  dek: Type.Optional(WrappedDek),
});
export type BundleHeader = Static<typeof BundleHeader>;

export const PartStart = Type.Union([
  Type.Object({ t: Type.Literal("part"), kind: Type.Literal("coordinator") }),
  Type.Object({
    t: Type.Literal("part"),
    kind: Type.Literal("agent"),
    id: AgentId,
  }),
]);
export type PartStart = Static<typeof PartStart>;

export const BundleRecord = Type.Union([
  SnapshotRecord,
  BundleHeader,
  PartStart,
  Type.Object({
    t: Type.Literal("blob"),
    key: BlobKey,
    size: Type.Number(),
    hash: Type.String(),
  }),
  Type.Object({ t: Type.Literal("blob-data"), data: Type.String() }),
  Type.Object({ t: Type.Literal("blob-end") }),
  Type.Object({ t: Type.Literal("part-end"), records: Type.Number() }),
  Type.Object({ t: Type.Literal("end"), parts: Type.Number() }),
]);
export type BundleRecord = Static<typeof BundleRecord>;

function parseRecord(line: string) {
  const value: unknown = JSON.parse(line);
  if (!Value.Check(BundleRecord, value))
    throw new BundleError("The bundle is damaged (an unknown record)");
  return value;
}

export class BundleError extends Error {}

export async function wrapDek(
  dek: Uint8Array<ArrayBuffer>,
  passphrase: string,
): Promise<WrappedDek> {
  const salt = randomBytes(16);
  const key = await passphraseKey(passphrase, salt, PASSPHRASE_ITERATIONS);
  return {
    kdf: "pbkdf2-sha256",
    iterations: PASSPHRASE_ITERATIONS,
    salt: toBase64(salt),
    sealed: await seal(key, dek, "neo-bundle-dek"),
  };
}

export async function unwrapDek(dek: WrappedDek, passphrase: string) {
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

export function encodeNdjson(records: AsyncIterable<BundleRecord>) {
  const encoder = new TextEncoder();
  const iterator = records[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else
        controller.enqueue(
          plainBytes(encoder.encode(`${JSON.stringify(next.value)}\n`)),
        );
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
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield parseRecord(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseRecord(buffer);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new BundleError(`The bundle is damaged (${error.message})`);
    throw error;
  }
}

export const encodeBundle = (records: AsyncIterable<BundleRecord>) =>
  encodeNdjson(records).pipeThrough(new CompressionStream("gzip"));

export const decodeBundle = (body: ReadableStream<Uint8Array>) =>
  decodeNdjson(
    body
      .pipeThrough(plainChunks())
      .pipeThrough(new DecompressionStream("gzip")),
  );

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
  for (let after = ""; hasBlobs;) {
    const page = await db.all<{ key: BlobKey; size: number; hash: string }>(
      `SELECT key, size, hash FROM vfs_blobs WHERE key > ? ORDER BY key LIMIT 100`,
      after,
    );
    const last = page.at(-1);
    if (!last) break;
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
    after = last.key;
  }
  yield { t: "part-end", records: count };
}

export async function readPart(
  records: AsyncIterator<BundleRecord>,
  db: SqliteDatabase,
  blobs: BlobStore,
) {
  let pending: BundleRecord | undefined;
  let count = 0;
  const next = async () => {
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

export function forwardPart(records: AsyncIterator<BundleRecord>) {
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

export async function readHeader(records: AsyncIterator<BundleRecord>) {
  const first = await records
    .next()
    .catch(() => ({ done: true as const, value: undefined }));
  if (first.done || first.value.t !== BUNDLE_FORMAT)
    throw new BundleError("Not a Neo bundle");
  const header = first.value;
  if (header.version !== BUNDLE_VERSION)
    throw new BundleError(
      `Bundle version ${header.version} is not supported (this Neo reads ${BUNDLE_VERSION})`,
    );
  return header;
}
