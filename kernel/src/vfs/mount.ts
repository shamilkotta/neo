import { plainBytes } from "../streams";
import {
  normalizePath,
  type Vfs,
  VfsError,
  type VfsErrorCode,
  type VfsFile,
  type VfsStat,
} from "./vfs";

export const SHARED_ROOT = "/shared";

type CreateParents = { createParents?: boolean };
type WriteOptions = CreateParents & { maxBytes?: number };
type ListOptions = { after?: string; limit?: number };
type RemoveOptions = { recursive?: boolean; force?: boolean };

export type SharedRequest =
  | { op: "stat"; path: string }
  | { op: "exists"; path: string }
  | { op: "readFile"; path: string }
  | { op: "readRange"; path: string; offset: number; length: number }
  | {
      op: "writeStream";
      path: string;
      stream: ReadableStream<Uint8Array>;
      options: WriteOptions;
    }
  | { op: "copyFile"; from: string; to: string; options: CreateParents }
  | { op: "appendFile"; path: string; content: string | Uint8Array }
  | { op: "truncate"; path: string; size: number }
  | { op: "mkdir"; path: string; options: { recursive?: boolean } }
  | { op: "readdir"; path: string; options: ListOptions }
  | { op: "rm"; path: string; options: RemoveOptions }
  | { op: "rename"; from: string; to: string }
  | { op: "walk"; path: string };

export type SharedOp = SharedRequest["op"];

interface SharedValues {
  stat: VfsStat;
  exists: boolean;
  readFile: Uint8Array;
  readRange: Uint8Array;
  writeStream: VfsStat;
  copyFile: null;
  appendFile: null;
  truncate: null;
  mkdir: null;
  readdir: VfsStat[];
  rm: null;
  rename: null;
  walk: VfsStat[];
}

type Answer<K extends SharedOp> = { op: K; value: SharedValues[K] };
type NullOp = {
  [K in SharedOp]: SharedValues[K] extends null ? K : never;
}[SharedOp];

export type SharedReply =
  | { [K in SharedOp]: Answer<K> }[SharedOp]
  | {
      op: "error";
      error: { code: VfsErrorCode; path: string; message: string };
    };

export type SharedCall = (request: SharedRequest) => Promise<SharedReply>;
export type SharedStream = (
  path: string,
) => Promise<ReadableStream<Uint8Array>>;

export async function serveShared(
  vfs: Vfs,
  request: SharedRequest,
): Promise<SharedReply> {
  try {
    return await answer(vfs, request);
  } catch (error) {
    if (error instanceof VfsError)
      return {
        op: "error",
        error: { code: error.code, path: error.path, message: error.message },
      };
    throw error;
  }
}

async function answer(vfs: Vfs, request: SharedRequest): Promise<SharedReply> {
  const done = async (
    op: NullOp,
    work: Promise<void>,
  ): Promise<SharedReply> => {
    await work;
    return { op, value: null };
  };
  switch (request.op) {
    case "stat":
      return { op: request.op, value: await vfs.stat(request.path) };
    case "exists":
      return { op: request.op, value: await vfs.exists(request.path) };
    case "readFile":
      return { op: request.op, value: await vfs.readFile(request.path) };
    case "readRange":
      return {
        op: request.op,
        value: await (
          await vfs.open(request.path)
        ).read(request.offset, request.length),
      };
    case "writeStream":
      return {
        op: request.op,
        value: await vfs.writeStream(
          request.path,
          request.stream,
          request.options,
        ),
      };
    case "copyFile":
      return done(
        request.op,
        vfs.copyFile(request.from, request.to, request.options),
      );
    case "appendFile":
      return done(request.op, vfs.appendFile(request.path, request.content));
    case "truncate":
      return done(request.op, vfs.truncate(request.path, request.size));
    case "mkdir":
      return done(request.op, vfs.mkdir(request.path, request.options));
    case "readdir":
      return {
        op: request.op,
        value: await vfs.readdir(request.path, request.options),
      };
    case "rm":
      return done(request.op, vfs.rm(request.path, request.options));
    case "rename":
      return done(request.op, vfs.rename(request.from, request.to));
    case "walk":
      return { op: request.op, value: await vfs.walk(request.path) };
    default: {
      const unknown: never = request;
      throw new Error(`Unknown shared operation ${JSON.stringify(unknown)}`);
    }
  }
}

export interface RemoteVfs {
  stat(path: string): Promise<VfsStat>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  readStream(path: string): Promise<ReadableStream<Uint8Array>>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: WriteOptions,
  ): Promise<VfsStat>;
  copyFile(from: string, to: string, options?: CreateParents): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  truncate(path: string, size: number): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options?: ListOptions): Promise<VfsStat[]>;
  rm(path: string, options?: RemoveOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  walk(path: string): Promise<VfsStat[]>;
}

function isAnswer<K extends SharedOp>(
  reply: SharedReply,
  op: K,
): reply is SharedReply & Answer<K> {
  return reply.op === op;
}

export function remoteVfs(call: SharedCall, stream: SharedStream): RemoteVfs {
  const run = async <K extends SharedOp>(
    request: SharedRequest & { op: K },
  ) => {
    const reply = await call(request);
    if (reply.op === "error")
      throw new VfsError(
        reply.error.code,
        reply.error.path,
        reply.error.message,
      );
    if (!isAnswer(reply, request.op))
      throw new Error(`/shared answered ${reply.op} to ${request.op}`);
    return reply.value;
  };
  const nothing = async (work: Promise<null>) => {
    await work;
  };
  return {
    stat: (path) => run({ op: "stat", path }),
    exists: (path) => run({ op: "exists", path }),
    readFile: (path) => run({ op: "readFile", path }),
    readStream: async (path) => {
      const stat = await run({ op: "stat", path });
      if (stat.kind !== "file") throw new VfsError("is_directory", stat.path);
      return stream(path);
    },
    readRange: (path, offset, length) =>
      run({ op: "readRange", path, offset, length }),
    writeStream: (path, stream, options = {}) =>
      run({ op: "writeStream", path, stream, options }),
    copyFile: (from, to, options = {}) =>
      nothing(run({ op: "copyFile", from, to, options })),
    appendFile: (path, content) =>
      nothing(run({ op: "appendFile", path, content })),
    truncate: (path, size) => nothing(run({ op: "truncate", path, size })),
    mkdir: (path, options = {}) => nothing(run({ op: "mkdir", path, options })),
    readdir: (path, options = {}) => run({ op: "readdir", path, options }),
    rm: (path, options = {}) => nothing(run({ op: "rm", path, options })),
    rename: (from, to) => nothing(run({ op: "rename", from, to })),
    walk: (path) => run({ op: "walk", path }),
  };
}

const ROUTED = [
  "stat",
  "exists",
  "readFile",
  "readText",
  "readStream",
  "open",
  "writeFile",
  "writeStream",
  "appendFile",
  "truncate",
  "mkdir",
  "readdir",
  "walk",
  "rm",
  "copyFile",
  "rename",
] as const satisfies readonly (keyof Vfs)[];
type Routed = (typeof ROUTED)[number];

const isRouted = (key: string | symbol): key is Routed =>
  ROUTED.some((name) => name === key);

export function mount(local: Vfs, prefix: string, remote: RemoteVfs) {
  const inside = (p: string) => p === prefix || p.startsWith(`${prefix}/`);
  const rel = (p: string) => p.slice(prefix.length) || "/";
  const out = (s: VfsStat): VfsStat => ({
    ...s,
    path: s.path === "/" ? prefix : prefix + s.path,
    name: s.path === "/" ? prefix.slice(1) : s.name,
  });
  const where = (path: string) => {
    const p = normalizePath(path);
    return { p, remote: inside(p), r: rel(p) };
  };
  const guardRoot = (p: string) => {
    if (p === prefix)
      throw new VfsError("read_only", p, `${p} cannot be removed or moved`);
  };
  const rootEntry = async () => out(await remote.stat("/"));
  const openRemote = async (path: string): Promise<VfsFile> => {
    const stat = out(await remote.stat(path));
    if (stat.kind !== "file") throw new VfsError("is_directory", stat.path);
    return {
      stat,
      async *chunks() {
        yield* await remote.readStream(path);
      },
      read: (offset, length) => remote.readRange(path, offset, length),
    };
  };
  const readStream = (path: string) => {
    const w = where(path);
    return w.remote ? remote.readStream(w.r) : local.readStream(w.p);
  };
  const writeStream = (
    path: string,
    stream: ReadableStream<Uint8Array>,
    options: { createParents?: boolean; maxBytes?: number } = {},
  ) => {
    const w = where(path);
    return w.remote
      ? remote.writeStream(w.r, stream, options).then(out)
      : local.writeStream(w.p, stream, options);
  };

  const routed: Pick<Vfs, Routed> = {
    stat: async (path: string) => {
      const w = where(path);
      return w.remote ? out(await remote.stat(w.r)) : local.stat(w.p);
    },
    exists: (path: string) => {
      const w = where(path);
      return w.remote ? remote.exists(w.r) : local.exists(w.p);
    },
    readFile: (path: string) => {
      const w = where(path);
      return w.remote ? remote.readFile(w.r) : local.readFile(w.p);
    },
    readText: async (path: string) => {
      const w = where(path);
      const bytes = w.remote
        ? await remote.readFile(w.r)
        : await local.readFile(w.p);
      return new TextDecoder().decode(bytes);
    },
    readStream,
    open: (path: string) => {
      const w = where(path);
      return w.remote ? openRemote(w.r) : local.open(w.p);
    },
    writeFile: (
      path: string,
      content: string | Uint8Array,
      options: { createParents?: boolean } = {},
    ) => {
      const w = where(path);
      if (!w.remote) return local.writeFile(w.p, content, options);
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      return remote
        .writeStream(w.r, new Blob([plainBytes(bytes)]).stream(), options)
        .then(() => {});
    },
    writeStream,
    appendFile: (path: string, content: string | Uint8Array) => {
      const w = where(path);
      return w.remote
        ? remote.appendFile(w.r, content)
        : local.appendFile(w.p, content);
    },
    truncate: (path: string, size: number) => {
      const w = where(path);
      return w.remote ? remote.truncate(w.r, size) : local.truncate(w.p, size);
    },
    mkdir: (path: string, options: { recursive?: boolean } = {}) => {
      const w = where(path);
      if (w.p === prefix)
        return options.recursive
          ? Promise.resolve()
          : Promise.reject(new VfsError("exists", w.p));
      return w.remote ? remote.mkdir(w.r, options) : local.mkdir(w.p, options);
    },
    readdir: async (
      path: string,
      options: { after?: string; limit?: number } = {},
    ) => {
      const w = where(path);
      if (w.remote) {
        const after =
          options.after && inside(options.after)
            ? rel(options.after)
            : options.after;
        return (
          await remote.readdir(w.r, { ...options, ...(after ? { after } : {}) })
        ).map(out);
      }
      const entries = await local.readdir(w.p, options);
      if (w.p !== "/") return entries;
      const after = options.after ?? "";
      if (prefix <= after || entries.some((e) => e.path === prefix))
        return entries;
      const all = [...entries, await rootEntry()].sort((a, b) =>
        a.path < b.path ? -1 : 1,
      );
      return options.limit && options.limit > 0
        ? all.slice(0, options.limit)
        : all;
    },
    walk: async (path: string) => {
      const w = where(path);
      if (w.remote) return (await remote.walk(w.r)).map(out);
      const entries = await local.walk(w.p);
      if (w.p !== "/") return entries;
      return [
        ...entries,
        await rootEntry(),
        ...(await remote.walk("/")).map(out),
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    rm: (
      path: string,
      options: { recursive?: boolean; force?: boolean } = {},
    ) => {
      const w = where(path);
      guardRoot(w.p);
      return w.remote ? remote.rm(w.r, options) : local.rm(w.p, options);
    },
    copyFile: async (
      from: string,
      to: string,
      options: { createParents?: boolean } = {},
    ) => {
      const a = where(from);
      const b = where(to);
      if (a.remote && b.remote) return remote.copyFile(a.r, b.r, options);
      if (!a.remote && !b.remote) return local.copyFile(a.p, b.p, options);
      await writeStream(b.p, await readStream(a.p), options);
    },
    rename: async (from: string, to: string) => {
      const a = where(from);
      const b = where(to);
      guardRoot(a.p);
      guardRoot(b.p);
      if (a.remote && b.remote) return remote.rename(a.r, b.r);
      if (!a.remote && !b.remote) return local.rename(a.p, b.p);
      const stat = a.remote ? await remote.stat(a.r) : await local.stat(a.p);
      if (stat.kind !== "file")
        throw new VfsError(
          "invalid",
          a.p,
          "Only files can move in or out of /shared",
        );
      await writeStream(b.p, await readStream(a.p));
      if (a.remote) await remote.rm(a.r);
      else await local.rm(a.p);
    },
  };

  return new Proxy(local, {
    get(target, key, receiver) {
      if (isRouted(key)) return routed[key];
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
