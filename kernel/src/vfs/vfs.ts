import type { SqliteDatabase, SqliteExecutor } from "../sql";
import {
  type BlobStore,
  bytesStream,
  collect,
  concatStreams,
  measured,
  zeroStream,
} from "./blobs";


export const CHUNK_SIZE = 512 * 1024;
export const INLINE_MAX = 256 * 1024;
export const MAX_FILE_SIZE = 64 * 1024 * 1024;
export const WHOLE_READ_MAX = 4 * 1024 * 1024;

export type VfsErrorCode =
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "exists"
  | "not_empty"
  | "invalid"
  | "too_large";

export class VfsError extends Error {
  constructor(
    readonly code: VfsErrorCode,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${code}: ${path}`);
  }
}

export interface VfsStat {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

interface NodeRow {
  path: string;
  parent: string;
  kind: "file" | "directory";
  size: number;
  mtime: number;
  chunks: string;
  blob: string | null;
}

export const VFS_SCHEMA = async (tx: SqliteExecutor): Promise<void> => {
  await tx.exec(`CREATE TABLE vfs_nodes (
    path TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    chunks TEXT NOT NULL,
    blob TEXT
  ) STRICT`);
  await tx.exec(`CREATE INDEX vfs_nodes_by_parent ON vfs_nodes (parent, path)`);
  await tx.exec(`CREATE TABLE vfs_chunks (
    hash TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    refs INTEGER NOT NULL
  ) STRICT`);
  await tx.exec(`CREATE TABLE vfs_blobs (
    key TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    refs INTEGER NOT NULL
  ) STRICT`);
};

export function normalizePath(path: string): string {
  if (!path.startsWith("/"))
    throw new VfsError("invalid", path, `Path must be absolute: ${path}`);
  if (path.includes("\0"))
    throw new VfsError("invalid", path, "Path contains a NUL byte");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function parentOf(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index === 0 ? "/" : path.slice(0, index);
}

export function baseName(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(base: string, path: string): string {
  return normalizePath(path.startsWith("/") ? path : `${base}/${path}`);
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Chunk data is not binary");
}

const encoder = new TextEncoder();

const PENDING = "host_vfs_pending_blobs";
const TRASH = "host_vfs_trash_blobs";
const HOST_TABLES = `CREATE TABLE IF NOT EXISTS ${PENDING} (key TEXT PRIMARY KEY) STRICT;
  CREATE TABLE IF NOT EXISTS ${TRASH} (key TEXT PRIMARY KEY) STRICT`;

export async function* rechunk(
  stream: ReadableStream<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        const n = Math.min(size - filled, value.length - offset);
        buffer.set(value.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === size) {
          yield buffer;
          buffer = new Uint8Array(size);
          filled = 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (filled > 0) yield buffer.slice(0, filled);
}

export interface VfsFile {
  stat: VfsStat;
  chunks(): AsyncIterable<Uint8Array>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type VfsListener = (paths: string[]) => void;

type Content =
  | { inline: Uint8Array }
  | { blob: { key: string; size: number; hash: string } };

export class Vfs {
  private readonly listeners = new Set<VfsListener>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly blobs: BlobStore,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: VfsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(paths: string[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(paths);
      } catch {
      }
    }
  }

  async stat(path: string): Promise<VfsStat> {
    const p = normalizePath(path);
    if (p === "/")
      return { path: "/", name: "/", kind: "directory", size: 0, mtimeMs: 0 };
    const row = await this.db.get<NodeRow>(
      `SELECT * FROM vfs_nodes WHERE path = ?`,
      p,
    );
    if (!row) throw new VfsError("not_found", p);
    return toStat(row);
  }

  async exists(path: string): Promise<boolean> {
    return this.stat(path).then(
      () => true,
      (error) => {
        if (error instanceof VfsError && error.code === "not_found")
          return false;
        throw error;
      },
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const row = await this.fileRow(this.db, p);
    if (row.size > WHOLE_READ_MAX)
      throw new VfsError(
        "too_large",
        p,
        `${p} is ${(row.size / 1024 / 1024).toFixed(1)} MB; whole-file reads are limited to ${WHOLE_READ_MAX / 1024 / 1024} MB. Read it in parts (the read tool's offset and limit).`,
      );
    if (row.blob) return collect(await this.blobStream(row), row.size);
    return this.assemble(this.db, row);
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const p = normalizePath(path);
    return this.contentStream(await this.fileRow(this.db, p));
  }

  async open(path: string): Promise<VfsFile> {
    const p = normalizePath(path);
    const row = await this.fileRow(this.db, p);
    const stat = toStat(row);
    if (row.blob) {
      const key = row.blob;
      const missing = () => new Error(`The content of ${p} is gone`);
      return {
        stat,
        chunks: async function* (this: Vfs) {
          const stream = await this.blobs.get(key);
          if (!stream) throw missing();
          yield* stream as unknown as AsyncIterable<Uint8Array>;
        }.bind(this),
        read: async (offset, length) => {
          const end = Math.min(offset + length, row.size);
          if (end <= offset) return new Uint8Array();
          const stream = await this.blobs.get(key, {
            offset,
            length: end - offset,
          });
          if (!stream) throw missing();
          return collect(stream, end - offset);
        },
      };
    }
    const hashes = JSON.parse(row.chunks) as string[];
    const chunk = (i: number) => this.chunk(this.db, hashes[i]!, p);
    return {
      stat,
      async *chunks() {
        for (let i = 0; i < hashes.length; i++) yield await chunk(i);
      },
      async read(offset: number, length: number) {
        const end = Math.min(offset + length, row.size);
        if (end <= offset) return new Uint8Array();
        const out = new Uint8Array(end - offset);
        for (
          let i = Math.floor(offset / CHUNK_SIZE);
          i * CHUNK_SIZE < end;
          i++
        ) {
          const data = await chunk(i);
          const start = i * CHUNK_SIZE;
          const from = Math.max(offset - start, 0);
          const to = Math.min(end - start, data.length);
          out.set(data.subarray(from, to), start + from - offset);
        }
        return out;
      },
    };
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options: { createParents?: boolean } = {},
  ): Promise<void> {
    const bytes =
      typeof content === "string" ? encoder.encode(content) : content;
    if (bytes.length > MAX_FILE_SIZE)
      throw new VfsError("too_large", normalizePath(path));
    await this.writeStream(path, bytesStream(bytes), options);
  }

  async writeStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options: { createParents?: boolean; maxBytes?: number } = {},
  ): Promise<VfsStat> {
    const p = normalizePath(path);
    if (options.createParents)
      await this.mkdir(parentOf(p), { recursive: true });
    await this.requireDirectory(this.db, parentOf(p));
    const max = Math.min(options.maxBytes ?? MAX_FILE_SIZE, MAX_FILE_SIZE);
    const content = await this.store(p, stream, max);
    await this.commit(p, content);
    return this.stat(p);
  }

  async copyFile(
    from: string,
    to: string,
    options: { createParents?: boolean } = {},
  ): Promise<void> {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === target) return;
    if (options.createParents)
      await this.mkdir(parentOf(target), { recursive: true });
    await this.db.transaction(async (tx) => {
      const row = await this.fileRow(tx, source);
      await this.requireDirectory(tx, parentOf(target));
      const existing = await tx.get<NodeRow>(
        `SELECT * FROM vfs_nodes WHERE path = ?`,
        target,
      );
      if (existing?.kind === "directory")
        throw new VfsError("is_directory", target);
      if (row.blob)
        await tx.run(
          `UPDATE vfs_blobs SET refs = refs + 1 WHERE key = ?`,
          row.blob,
        );
      for (const hash of JSON.parse(row.chunks) as string[])
        await tx.run(
          `UPDATE vfs_chunks SET refs = refs + 1 WHERE hash = ?`,
          hash,
        );
      if (existing) await this.release(tx, existing);
      await this.upsertFile(tx, target, row.size, row.chunks, row.blob);
    });
    await this.emptyTrash();
    this.emit([target]);
  }

  async repair(): Promise<void> {
    await this.db.exec(HOST_TABLES);
    const cut = await this.db.all<{ key: string }>(
      `SELECT key FROM ${PENDING} WHERE key NOT IN (SELECT key FROM vfs_blobs)`,
    );
    for (const { key } of cut) await this.blobs.delete(key);
    await this.db.run(`DELETE FROM ${PENDING}`);
    await this.emptyTrash();
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const p = normalizePath(path);
    const extra =
      typeof content === "string" ? encoder.encode(content) : content;
    const row = await this.db.get<NodeRow>(
      `SELECT * FROM vfs_nodes WHERE path = ?`,
      p,
    );
    if (!row) return this.writeFile(p, extra);
    if (row.kind === "directory") throw new VfsError("is_directory", p);
    if (row.size + extra.length > MAX_FILE_SIZE)
      throw new VfsError("too_large", p);
    const stored = await this.store(
      p,
      concatStreams([
        () => this.contentStream(row),
        async () => bytesStream(extra),
      ]),
      MAX_FILE_SIZE,
    );
    await this.commit(p, stored, row);
  }

  async truncate(path: string, size: number): Promise<void> {
    if (!Number.isInteger(size) || size < 0)
      throw new VfsError(
        "invalid",
        path,
        "Size must be a non-negative integer",
      );
    const p = normalizePath(path);
    const row = await this.fileRow(this.db, p);
    if (size > MAX_FILE_SIZE) throw new VfsError("too_large", p);
    if (size === row.size) return;
    const keep = Math.min(size, row.size);
    const stored = await this.store(
      p,
      concatStreams([
        async () =>
          keep === 0
            ? bytesStream(new Uint8Array())
            : this.rangeStream(row, keep),
        async () => zeroStream(size - keep),
      ]),
      MAX_FILE_SIZE,
    );
    await this.commit(p, stored, row);
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    const p = normalizePath(path);
    if (p === "/") {
      if (options.recursive) return;
      throw new VfsError("exists", p);
    }
    const created: string[] = [];
    await this.db.transaction(async (tx) => {
      const existing = await tx.get<{ kind: string }>(
        `SELECT kind FROM vfs_nodes WHERE path = ?`,
        p,
      );
      if (existing) {
        if (existing.kind !== "directory") throw new VfsError("exists", p);
        if (!options.recursive) throw new VfsError("exists", p);
        return;
      }
      if (!options.recursive) {
        await this.requireDirectory(tx, parentOf(p));
        await this.insertDirectory(tx, p);
        created.push(p);
        return;
      }
      const missing = [p];
      for (
        let cursor = parentOf(p);
        cursor !== "/";
        cursor = parentOf(cursor)
      ) {
        const row = await tx.get<{ kind: string }>(
          `SELECT kind FROM vfs_nodes WHERE path = ?`,
          cursor,
        );
        if (row) {
          if (row.kind !== "directory")
            throw new VfsError("not_directory", cursor);
          break;
        }
        missing.push(cursor);
      }
      for (const dir of missing.reverse()) await this.insertDirectory(tx, dir);
      created.push(missing[0]!);
    });
    if (created.length > 0) this.emit(created);
  }

  async readdir(
    path: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<VfsStat[]> {
    const p = normalizePath(path);
    await this.requireDirectory(this.db, p);
    const rows = await this.db.all<NodeRow>(
      `SELECT * FROM vfs_nodes WHERE parent = ? AND path > ? ORDER BY path LIMIT ?`,
      p,
      options.after ?? "",
      options.limit ?? -1,
    );
    return rows.map(toStat);
  }

  async rm(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const p = normalizePath(path);
    if (p === "/") throw new VfsError("invalid", p, "Cannot remove the root");
    let removed = false;
    await this.db.transaction(async (tx) => {
      const row = await tx.get<NodeRow>(
        `SELECT * FROM vfs_nodes WHERE path = ?`,
        p,
      );
      if (!row) {
        if (options.force) return;
        throw new VfsError("not_found", p);
      }
      const descendants = await tx.all<NodeRow>(
        `SELECT * FROM vfs_nodes WHERE path > ? AND path < ?`,
        `${p}/`,
        `${p}0`,
      );
      if (
        row.kind === "directory" &&
        descendants.length > 0 &&
        !options.recursive
      )
        throw new VfsError("not_empty", p);
      for (const node of [row, ...descendants]) await this.release(tx, node);
      await tx.run(
        `DELETE FROM vfs_nodes WHERE path = ? OR (path > ? AND path < ?)`,
        p,
        `${p}/`,
        `${p}0`,
      );
      removed = true;
    });
    await this.emptyTrash();
    if (removed) this.emit([p]);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === target) return;
    if (target.startsWith(`${source}/`))
      throw new VfsError(
        "invalid",
        target,
        "Cannot move a directory into itself",
      );
    await this.db.transaction(async (tx) => {
      const row = await tx.get<NodeRow>(
        `SELECT * FROM vfs_nodes WHERE path = ?`,
        source,
      );
      if (!row) throw new VfsError("not_found", source);
      await this.requireDirectory(tx, parentOf(target));
      const existing = await tx.get<NodeRow>(
        `SELECT * FROM vfs_nodes WHERE path = ?`,
        target,
      );
      if (existing) {
        if (existing.kind === "directory" || row.kind === "directory")
          throw new VfsError("exists", target);
        await this.release(tx, existing);
        await tx.run(`DELETE FROM vfs_nodes WHERE path = ?`, target);
      }
      const moved = await tx.all<NodeRow>(
        `SELECT * FROM vfs_nodes WHERE path = ? OR (path > ? AND path < ?)`,
        source,
        `${source}/`,
        `${source}0`,
      );
      await tx.run(
        `DELETE FROM vfs_nodes WHERE path = ? OR (path > ? AND path < ?)`,
        source,
        `${source}/`,
        `${source}0`,
      );
      for (const node of moved) {
        const path = target + node.path.slice(source.length);
        await tx.run(
          `INSERT INTO vfs_nodes (path, parent, kind, size, mtime, chunks, blob) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          path,
          parentOf(path),
          node.kind,
          node.size,
          node.path === source ? this.now() : node.mtime,
          node.chunks,
          node.blob,
        );
      }
    });
    await this.emptyTrash();
    this.emit([source, target]);
  }

  async walk(path: string): Promise<VfsStat[]> {
    const p = normalizePath(path);
    await this.requireDirectory(this.db, p);
    const prefix = p === "/" ? "/" : `${p}/`;
    const rows = await this.db.all<NodeRow>(
      `SELECT * FROM vfs_nodes WHERE path >= ? AND path < ? ORDER BY path`,
      prefix,
      `${prefix.slice(0, -1)}0`,
    );
    return rows.map(toStat);
  }


  private async store(
    p: string,
    stream: ReadableStream<Uint8Array>,
    max: number,
  ): Promise<Content> {
    const reader = stream.getReader();
    const head: Uint8Array[] = [];
    let size = 0;
    let done = false;
    try {
      while (size <= INLINE_MAX) {
        const next = await reader.read();
        if (next.done) {
          done = true;
          break;
        }
        head.push(next.value);
        size += next.value.length;
        if (size > max) throw new VfsError("too_large", p);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    if (done) {
      reader.releaseLock();
      const inline = new Uint8Array(size);
      let offset = 0;
      for (const h of head) {
        inline.set(h, offset);
        offset += h.length;
      }
      return { inline };
    }
    const rest = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    const body = measured(
      concatStreams([
        ...head.map((h) => async () => bytesStream(h)),
        async () => rest,
      ]),
      max,
      () => new VfsError("too_large", p),
    );
    const key = crypto.randomUUID();
    await this.db.exec(HOST_TABLES);
    await this.db.run(`INSERT INTO ${PENDING} (key) VALUES (?)`, key);
    try {
      await this.blobs.put(key, body.stream);
    } catch (error) {
      await reader.cancel().catch(() => {});
      await this.blobs.delete(key).catch(() => {});
      await this.db.run(`DELETE FROM ${PENDING} WHERE key = ?`, key);
      throw error;
    }
    return { blob: { key, ...body.result() } };
  }

  private async commit(
    p: string,
    content: Content,
    expected?: NodeRow,
  ): Promise<void> {
    const pieces =
      "inline" in content ? await this.hashChunks(content.inline) : [];
    try {
      await this.db.transaction(async (tx) => {
        await this.requireDirectory(tx, parentOf(p));
        const existing = await tx.get<NodeRow>(
          `SELECT * FROM vfs_nodes WHERE path = ?`,
          p,
        );
        if (existing?.kind === "directory")
          throw new VfsError("is_directory", p);
        if (
          expected &&
          (existing?.chunks !== expected.chunks ||
            existing.blob !== expected.blob ||
            existing.size !== expected.size)
        )
          throw new VfsError(
            "invalid",
            p,
            `${p} changed while it was being written`,
          );
        for (const piece of pieces)
          await this.addChunkRef(tx, piece.hash, piece.data);
        if ("blob" in content) {
          await tx.run(
            `INSERT INTO vfs_blobs (key, size, hash, refs) VALUES (?, ?, ?, 1)`,
            content.blob.key,
            content.blob.size,
            content.blob.hash,
          );
          await tx.run(
            `DELETE FROM ${PENDING} WHERE key = ?`,
            content.blob.key,
          );
        }
        if (existing) await this.release(tx, existing);
        await this.upsertFile(
          tx,
          p,
          "inline" in content ? content.inline.length : content.blob.size,
          JSON.stringify(pieces.map((c) => c.hash)),
          "blob" in content ? content.blob.key : null,
        );
      });
    } catch (error) {
      if ("blob" in content) {
        await this.blobs.delete(content.blob.key).catch(() => {});
        await this.db.run(
          `DELETE FROM ${PENDING} WHERE key = ?`,
          content.blob.key,
        );
      }
      throw error;
    }
    await this.emptyTrash();
    this.emit([p]);
  }

  private async upsertFile(
    tx: SqliteExecutor,
    p: string,
    size: number,
    chunks: string,
    blob: string | null,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO vfs_nodes (path, parent, kind, size, mtime, chunks, blob) VALUES (?, ?, 'file', ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, chunks = excluded.chunks, blob = excluded.blob`,
      p,
      parentOf(p),
      size,
      this.now(),
      chunks,
      blob,
    );
  }

  private async release(tx: SqliteExecutor, row: NodeRow): Promise<void> {
    if (row.kind !== "file") return;
    await this.releaseChunks(tx, JSON.parse(row.chunks) as string[]);
    if (!row.blob) return;
    await tx.run(
      `UPDATE vfs_blobs SET refs = refs - 1 WHERE key = ?`,
      row.blob,
    );
    const left = await tx.get<{ refs: number }>(
      `SELECT refs FROM vfs_blobs WHERE key = ?`,
      row.blob,
    );
    if (left && left.refs <= 0) {
      await tx.run(`DELETE FROM vfs_blobs WHERE key = ?`, row.blob);
      await tx.exec(HOST_TABLES);
      await tx.run(
        `INSERT INTO ${TRASH} (key) VALUES (?) ON CONFLICT DO NOTHING`,
        row.blob,
      );
    }
  }

  private async emptyTrash(): Promise<void> {
    await this.db.exec(HOST_TABLES);
    const trash = await this.db.all<{ key: string }>(
      `SELECT key FROM ${TRASH}`,
    );
    for (const { key } of trash) {
      await this.blobs.delete(key);
      await this.db.run(`DELETE FROM ${TRASH} WHERE key = ?`, key);
    }
  }

  private async contentStream(
    row: NodeRow,
  ): Promise<ReadableStream<Uint8Array>> {
    if (row.blob) return this.blobStream(row);
    const hashes = JSON.parse(row.chunks) as string[];
    let index = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const hash = hashes[index++];
          if (hash === undefined) return controller.close();
          controller.enqueue(await this.chunk(this.db, hash, row.path));
        },
      },
      { highWaterMark: 0 },
    );
  }

  private async rangeStream(
    row: NodeRow,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    if (row.blob) {
      const stream = await this.blobs.get(row.blob, { offset: 0, length });
      if (!stream) throw new Error(`The content of ${row.path} is gone`);
      return stream;
    }
    let left = length;
    const reader = (await this.contentStream(row)).getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = left > 0 ? await reader.read() : { done: true as const };
        if (next.done) {
          await reader.cancel().catch(() => {});
          return controller.close();
        }
        const piece = next.value.subarray(0, left);
        left -= piece.length;
        controller.enqueue(piece);
      },
    });
  }

  private async blobStream(row: NodeRow): Promise<ReadableStream<Uint8Array>> {
    const stream = await this.blobs.get(row.blob!);
    if (!stream) throw new Error(`The content of ${row.path} is gone`);
    return stream;
  }

  private async fileRow(db: SqliteExecutor, p: string): Promise<NodeRow> {
    const row = await db.get<NodeRow>(
      `SELECT * FROM vfs_nodes WHERE path = ?`,
      p,
    );
    if (!row) {
      await this.requireDirectory(db, parentOf(p));
      throw new VfsError("not_found", p);
    }
    if (row.kind === "directory") throw new VfsError("is_directory", p);
    return row;
  }

  private async assemble(
    db: SqliteExecutor,
    row: NodeRow,
  ): Promise<Uint8Array> {
    const out = new Uint8Array(row.size);
    let offset = 0;
    for (const hash of JSON.parse(row.chunks) as string[]) {
      const data = await this.chunk(db, hash, row.path);
      out.set(data, offset);
      offset += data.length;
    }
    return out;
  }

  private async chunk(
    db: SqliteExecutor,
    hash: string,
    path: string,
  ): Promise<Uint8Array> {
    const chunk = await db.get<{ data: unknown }>(
      `SELECT data FROM vfs_chunks WHERE hash = ?`,
      hash,
    );
    if (!chunk) throw new Error(`Missing chunk ${hash} of ${path}`);
    return toBytes(chunk.data);
  }

  private async requireDirectory(db: SqliteExecutor, p: string): Promise<void> {
    if (p === "/") return;
    const row = await db.get<{ kind: string }>(
      `SELECT kind FROM vfs_nodes WHERE path = ?`,
      p,
    );
    if (!row) throw new VfsError("not_found", p);
    if (row.kind !== "directory") throw new VfsError("not_directory", p);
  }

  private async insertDirectory(tx: SqliteExecutor, p: string): Promise<void> {
    await tx.run(
      `INSERT INTO vfs_nodes (path, parent, kind, size, mtime, chunks) VALUES (?, ?, 'directory', 0, ?, '[]')`,
      p,
      parentOf(p),
      this.now(),
    );
  }

  private async hashChunks(
    bytes: Uint8Array,
  ): Promise<{ hash: string; data: Uint8Array }[]> {
    const pieces: { hash: string; data: Uint8Array }[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const data = bytes.slice(offset, offset + CHUNK_SIZE);
      pieces.push({ hash: await sha256(data), data });
    }
    return pieces;
  }

  private async addChunkRef(
    tx: SqliteExecutor,
    hash: string,
    data: Uint8Array,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO vfs_chunks (hash, data, refs) VALUES (?, ?, 1) ON CONFLICT(hash) DO UPDATE SET refs = refs + 1`,
      hash,
      data,
    );
  }

  private async releaseChunks(
    tx: SqliteExecutor,
    hashes: string[],
  ): Promise<void> {
    for (const hash of hashes) {
      await tx.run(
        `UPDATE vfs_chunks SET refs = refs - 1 WHERE hash = ?`,
        hash,
      );
      await tx.run(`DELETE FROM vfs_chunks WHERE hash = ? AND refs <= 0`, hash);
    }
  }
}

function toStat(row: NodeRow): VfsStat {
  return {
    path: row.path,
    name: baseName(row.path),
    kind: row.kind,
    size: row.size,
    mtimeMs: row.mtime,
  };
}
