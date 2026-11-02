import {
  normalizePath,
  type Vfs,
  VfsError,
  type VfsErrorCode,
  type VfsFile,
  type VfsStat,
} from "./vfs";

// `/shared` lives in the coordinator; each agent mounts it. The coordinator serves a small,
// RPC-safe slice of its Vfs (`serveShared`); agents call it through `remoteVfs` and see it at
// `/shared` through `mount`, so every tool and the shell work there as anywhere else.

export const SHARED_ROOT = "/shared";

const OPS = [
  "stat",
  "exists",
  "readFile",
  "readStream",
  "readRange",
  "writeStream",
  "copyFile",
  "appendFile",
  "truncate",
  "mkdir",
  "readdir",
  "rm",
  "rename",
  "walk",
] as const;
export type SharedOp = (typeof OPS)[number];

export type SharedResult =
  | { value: unknown }
  | { error: { code: VfsErrorCode; path: string; message: string } };

/** What an agent's /shared calls (over RPC). */
export type SharedCall = (
  op: SharedOp,
  args: unknown[],
) => Promise<SharedResult>;
/** A file's bytes; a stream travels as a result only on its own, not inside an object. */
export type SharedStream = (
  path: string,
) => Promise<ReadableStream<Uint8Array>>;

/** The coordinator's side: one call on its shared Vfs. Vfs errors travel as data. */
export async function serveShared(
  vfs: Vfs,
  op: SharedOp,
  args: unknown[],
): Promise<SharedResult> {
  if (!OPS.includes(op)) throw new Error(`Unknown shared operation ${op}`);
  try {
    if (op === "readRange") {
      const [path, offset, length] = args as [string, number, number];
      return { value: await (await vfs.open(path)).read(offset, length) };
    }
    const fn = (vfs as unknown as Record<string, (...a: unknown[]) => unknown>)[
      op
    ]!;
    return { value: await fn.apply(vfs, args) };
  } catch (error) {
    if (error instanceof VfsError)
      return {
        error: { code: error.code, path: error.path, message: error.message },
      };
    throw error;
  }
}

/** The agent's side of /shared: paths are relative to its root. */
export interface RemoteVfs {
  stat(path: string): Promise<VfsStat>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  readStream(path: string): Promise<ReadableStream<Uint8Array>>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: { createParents?: boolean; maxBytes?: number },
  ): Promise<VfsStat>;
  copyFile(
    from: string,
    to: string,
    options?: { createParents?: boolean },
  ): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  truncate(path: string, size: number): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(
    path: string,
    options?: { after?: string; limit?: number },
  ): Promise<VfsStat[]>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  walk(path: string): Promise<VfsStat[]>;
}

export function remoteVfs(call: SharedCall, stream: SharedStream): RemoteVfs {
  const run = async (op: SharedOp, ...args: unknown[]) => {
    const result = await call(op, args);
    if ("error" in result)
      throw new VfsError(
        result.error.code,
        result.error.path,
        result.error.message,
      );
    return result.value as never;
  };
  return {
    stat: (p) => run("stat", p),
    exists: (p) => run("exists", p),
    readFile: (p) => run("readFile", p),
    readStream: async (p) => {
      const stat = (await run("stat", p)) as VfsStat;
      if (stat.kind !== "file") throw new VfsError("is_directory", stat.path);
      return stream(p);
    },
    readRange: (p, offset, length) => run("readRange", p, offset, length),
    writeStream: (p, stream, options = {}) =>
      run("writeStream", p, stream, options),
    copyFile: (from, to, options = {}) => run("copyFile", from, to, options),
    appendFile: (p, content) => run("appendFile", p, content),
    truncate: (p, size) => run("truncate", p, size),
    mkdir: (p, options = {}) => run("mkdir", p, options),
    readdir: (p, options = {}) => run("readdir", p, options),
    rm: (p, options = {}) => run("rm", p, options),
    rename: (from, to) => run("rename", from, to),
    walk: (p) => run("walk", p),
  };
}

/** The local Vfs with `remote` seen at `prefix`. Moves and copies across the two stream. */
export function mount(local: Vfs, prefix: string, remote: RemoteVfs): Vfs {
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
        yield* (await remote.readStream(
          path,
        )) as unknown as AsyncIterable<Uint8Array>;
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
  ): Promise<VfsStat> => {
    const w = where(path);
    return w.remote
      ? remote.writeStream(w.r, stream, options).then(out)
      : local.writeStream(w.p, stream, options);
  };

  const routed: Partial<Record<keyof Vfs, (...args: any[]) => unknown>> = {
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
        .writeStream(
          w.r,
          new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(),
          options,
        )
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
      const own =
        typeof key === "string" ? routed[key as keyof Vfs] : undefined;
      if (own) return own;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
