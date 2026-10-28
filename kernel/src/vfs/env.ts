import type { Context } from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  err,
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  LineScanner,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { VfsShell } from "./bash";
import {
  joinPath,
  normalizePath,
  Vfs,
  VfsError,
  type VfsFile,
  type VfsStat,
} from "./vfs";

/**
 * Pi's `ExecutionEnv` over the SQLite VFS: the same files and behavior on every host.
 *
 * `exec` runs commands in the VFS shell (just-bash) when one is given: the same shell on every
 * host, with no real processes.
 */
export class VfsExecutionEnv implements ExecutionEnv {
  constructor(
    private readonly vfs: Vfs,
    public cwd: string,
    /** Equal ids see the same files: one per instance. */
    readonly id: string,
    private readonly shell?: VfsShell,
  ) {
    this.cwd = normalizePath(cwd);
  }

  private resolve(path: string): string {
    return joinPath(this.cwd, path);
  }

  absolutePath(path: string, context: Context) {
    return attempt(context, path, async () => this.resolve(path));
  }

  joinPath(parts: string[], context: Context) {
    return attempt(context, parts.join("/"), async () => {
      const [first = ".", ...rest] = parts;
      return rest.reduce(
        (acc, part) => joinPath(acc, part),
        this.resolve(first),
      );
    });
  }

  readTextFile(path: string, context: Context) {
    return attempt(context, path, () => this.vfs.readText(this.resolve(path)));
  }

  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ) {
    return attempt(context, path, async () => {
      if (options?.maxLines === undefined)
        return splitLines(await this.vfs.readText(this.resolve(path)));
      // Only as many chunks as the lines asked for.
      const lines: string[] = [];
      for await (const line of fileLines(
        await this.vfs.open(this.resolve(path)),
      )) {
        if (lines.length >= options.maxLines) break;
        lines.push(line.text);
      }
      return lines;
    });
  }

  openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    return attempt(context, path, async () => {
      const lines = fileLines(await this.vfs.open(this.resolve(path)))[
        Symbol.asyncIterator
      ]();
      return {
        readLine: async (ctx: Context) => {
          if (ctx.abortSignal?.aborted)
            return err(new FileError("aborted", "Aborted", path));
          const next = await lines.next();
          return ok(next.done ? undefined : next.value);
        },
        close: async () => {
          await lines.return?.(undefined);
        },
      };
    });
  }

  readBinaryFile(path: string, context: Context) {
    return attempt(context, path, () => this.vfs.readFile(this.resolve(path)));
  }

  openBinaryReader(
    path: string,
    _options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return attempt(context, path, async () => {
      const absolute = this.resolve(path);
      // The reader keeps the chunks it opened, so a later rename or write doesn't change what it
      // reads; it loads only the chunks a read touches.
      const stat = await this.vfs.stat(absolute);
      if (stat.kind === "directory")
        throw new VfsError("is_directory", absolute);
      const file = await this.vfs.open(absolute);
      const info = toFileInfo(stat);
      let closed = false;
      const usable = (ctx: Context): FileError | undefined => {
        if (closed) return new FileError("invalid", "Reader is closed", path);
        if (ctx.abortSignal?.aborted)
          return new FileError("aborted", "Aborted", path);
        return undefined;
      };
      return {
        info: async (ctx: Context) => {
          const problem = usable(ctx);
          return problem ? err(problem) : ok(info);
        },
        read: async (offset: number, length: number, ctx: Context) => {
          const problem = usable(ctx);
          if (problem) return err(problem);
          if (
            !Number.isInteger(offset) ||
            !Number.isInteger(length) ||
            offset < 0 ||
            length < 0
          ) {
            return err(
              new FileError(
                "invalid",
                "Offset and length must be non-negative integers",
                path,
              ),
            );
          }
          return ok(await file.read(offset, length));
        },
        scanLines: async (
          options: { startLine: number; endLine?: number },
          ctx: Context,
        ) => {
          const problem = usable(ctx);
          if (problem) return err(problem);
          let scanner: LineScanner;
          try {
            scanner = new LineScanner(options.startLine, options.endLine);
          } catch {
            return err(new FileError("invalid", "Invalid line range", path));
          }
          for await (const chunk of file.chunks()) {
            if (ctx.abortSignal?.aborted)
              return err(new FileError("aborted", "Aborted", path));
            scanner.push(chunk);
          }
          return ok(scanner.finish());
        },
        close: async () => {
          closed = true;
        },
      };
    });
  }

  writeFile(path: string, content: string | Uint8Array, context: Context) {
    // Like Node's environment, a write creates missing parent directories.
    return attempt(context, path, () =>
      this.vfs.writeFile(this.resolve(path), content, { createParents: true }),
    );
  }

  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return attempt(context, path, () =>
      this.vfs.appendFile(this.resolve(path), content),
    );
  }

  truncateFile(path: string, size: number, context: Context) {
    return attempt(context, path, () =>
      this.vfs.truncate(this.resolve(path), size),
    );
  }

  flushFile(path: string, context: Context) {
    // Every write is already committed to SQLite.
    return attempt(
      context,
      path,
      async () => void (await this.vfs.stat(this.resolve(path))),
    );
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return attempt(context, sourcePath, () =>
      this.vfs.rename(this.resolve(sourcePath), this.resolve(destinationPath)),
    );
  }

  fileInfo(path: string, context: Context) {
    return attempt(context, path, async () =>
      toFileInfo(await this.vfs.stat(this.resolve(path))),
    );
  }

  listDir(path: string, context: Context) {
    return attempt(context, path, async () =>
      (await this.vfs.readdir(this.resolve(path))).map(toFileInfo),
    );
  }

  openDirReader(
    path: string,
    context: Context,
  ): Promise<Result<DirReader, FileError>> {
    return attempt(context, path, async () => {
      const absolute = this.resolve(path);
      const stat = await this.vfs.stat(absolute);
      if (stat.kind !== "directory")
        throw new VfsError("not_directory", absolute);
      // Pages by name, so an entry removed before its page is skipped and none is seen twice.
      let after: string | undefined;
      let done = false;
      let closed = false;
      return {
        next: (maxEntries: number, ctx: Context) =>
          attempt(ctx, path, async () => {
            if (closed)
              throw new VfsError(
                "invalid",
                absolute,
                "Directory reader is closed",
              );
            if (!Number.isInteger(maxEntries) || maxEntries < 1)
              throw new VfsError(
                "invalid",
                absolute,
                "maxEntries must be a positive integer",
              );
            if (done) return { entries: [], done: true };
            const page = await this.vfs.readdir(absolute, {
              ...(after === undefined ? {} : { after }),
              limit: maxEntries + 1,
            });
            const entries = page.slice(0, maxEntries);
            if (entries.length > 0) after = entries.at(-1)!.path;
            done = page.length <= maxEntries;
            return { entries: entries.map(toFileInfo), done };
          }),
        close: async () => {
          closed = true;
        },
      };
    });
  }

  /** Every write goes through the Vfs, so changes are reported as they commit (`native`). */
  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    if (context.abortSignal?.aborted)
      return err(new FileError("aborted", "Aborted"));
    const resolved = targets.map((t) => ({ ...t, path: this.resolve(t.path) }));
    const unsubscribe = this.vfs.subscribe((paths) => {
      const reported = paths.filter((p) =>
        resolved.some((t) => watchedBy(t, p)),
      );
      if (reported.length > 0) onChange({ paths: reported });
    });
    return ok({ mode: "native", close: async () => void unsubscribe() });
  }

  canonicalPath(path: string, context: Context) {
    return attempt(
      context,
      path,
      async () => (await this.vfs.stat(this.resolve(path))).path,
    );
  }

  exists(path: string, context: Context) {
    return attempt(context, path, () => this.vfs.exists(this.resolve(path)));
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ) {
    return attempt(context, path, () =>
      this.vfs.mkdir(this.resolve(path), options),
    );
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return attempt(context, path, () =>
      this.vfs.rm(this.resolve(path), options),
    );
  }

  createTempDir(prefix: string | undefined, context: Context) {
    return attempt(context, "/tmp", async () => {
      const path = `/tmp/${prefix ?? "tmp-"}${crypto.randomUUID()}`;
      await this.vfs.mkdir(path, { recursive: true });
      return path;
    });
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ) {
    return attempt(context, "/tmp", async () => {
      await this.vfs.mkdir("/tmp", { recursive: true });
      const path = `/tmp/${options?.prefix ?? "tmp-"}${crypto.randomUUID()}${options?.suffix ?? ""}`;
      await this.vfs.writeFile(path, "");
      return path;
    });
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (!this.shell)
      return err(
        new ExecutionError(
          "shell_unavailable",
          "This host has no shell for the workspace",
        ),
      );
    if (Array.isArray(command) && command.length === 0)
      return err(new ExecutionError("spawn_error", "Empty command"));
    const line =
      typeof command === "string" ? command : command.map(shellQuote).join(" ");
    const signals = [
      context.abortSignal,
      options?.timeout
        ? AbortSignal.timeout(options.timeout * 1000)
        : undefined,
    ].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    if (signal?.aborted) return err(new ExecutionError("aborted", "Aborted"));
    let cwd: string;
    try {
      cwd = options?.cwd ? this.resolve(options.cwd) : this.cwd;
    } catch (error) {
      return err(
        new ExecutionError(
          "spawn_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    try {
      const result = await this.shell.run(line, {
        cwd,
        ...(options?.env ? { env: options.env } : {}),
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) {
        return err(
          new ExecutionError(
            context.abortSignal?.aborted ? "aborted" : "timeout",
            context.abortSignal?.aborted ? "Aborted" : "Timed out",
          ),
        );
      }
      if (result.stdout)
        options?.onOutput?.(result.stdout, context, { stream: "stdout" });
      if (result.stderr)
        options?.onOutput?.(result.stderr, context, { stream: "stderr" });
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      if (signal?.aborted)
        return err(
          new ExecutionError(
            context.abortSignal?.aborted ? "aborted" : "timeout",
            "Stopped",
          ),
        );
      return err(
        new ExecutionError(
          "unknown",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async cleanup(): Promise<void> {}
}

const FILE_ERROR_CODES: Record<VfsError["code"], FileErrorCode> = {
  not_found: "not_found",
  is_directory: "is_directory",
  not_directory: "not_directory",
  exists: "invalid",
  not_empty: "invalid",
  invalid: "invalid",
  too_large: "invalid",
};

async function attempt<T>(
  context: Context,
  path: string,
  operation: () => Promise<T>,
): Promise<Result<T, FileError>> {
  if (context.abortSignal?.aborted)
    return err(new FileError("aborted", "Aborted", path));
  try {
    return ok(await operation());
  } catch (error) {
    if (error instanceof VfsError)
      return err(
        new FileError(FILE_ERROR_CODES[error.code], error.message, error.path),
      );
    if (error instanceof FileError) return err(error);
    return err(
      new FileError(
        "unknown",
        error instanceof Error ? error.message : String(error),
        path,
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

function toFileInfo(stat: VfsStat): FileInfo {
  return {
    name: stat.name,
    path: stat.path,
    kind: stat.kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/** Whether a change at `changed` concerns a watch target. */
function watchedBy(target: WatchTarget, changed: string): boolean {
  if (changed === target.path || target.path.startsWith(`${changed}/`))
    return true; // the target or an ancestor
  const prefix = target.path === "/" ? "/" : `${target.path}/`;
  if (!changed.startsWith(prefix)) return false;
  const below = changed.slice(prefix.length).split("/");
  if (!target.recursive && below.length > 1) return false;
  const exclude = target.exclude;
  return !below.some(
    (name) =>
      (exclude?.hidden && name.startsWith(".")) ||
      exclude?.names?.includes(name),
  );
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A file's lines, decoded a chunk at a time (`terminated`: the line ended with a newline). */
async function* fileLines(
  file: VfsFile,
): AsyncGenerator<{ text: string; terminated: boolean }> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of file.chunks()) {
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      yield { text: pending.slice(0, newline), terminated: true };
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending !== "") yield { text: pending, terminated: false };
}
