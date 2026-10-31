import { Bash, type IFileSystem } from "just-bash";
import {
  joinPath,
  normalizePath,
  type Vfs,
  VfsError,
  type VfsStat,
  WHOLE_READ_MAX,
} from "./vfs";


const POSIX: Record<VfsError["code"], [string, string]> = {
  not_found: ["ENOENT", "no such file or directory"],
  is_directory: ["EISDIR", "illegal operation on a directory"],
  not_directory: ["ENOTDIR", "not a directory"],
  exists: ["EEXIST", "file already exists"],
  not_empty: ["ENOTEMPTY", "directory not empty"],
  invalid: ["EINVAL", "invalid argument"],
  read_only: ["EROFS", "read-only file system"],
  too_large: [
    "EFBIG",
    "file too large for the shell (it reads whole files; use the read tool with offset and limit)",
  ],
};

function posix(op: string, path: string, error: unknown): Error {
  if (!(error instanceof VfsError))
    return error instanceof Error ? error : new Error(String(error));
  const [code, text] = POSIX[error.code];
  return Object.assign(new Error(`${code}: ${text}, ${op} '${path}'`), {
    code,
  });
}

async function wrap<T>(
  op: string,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw posix(op, path, error);
  }
}

const encoder = new TextEncoder();

function toStat(stat: VfsStat) {
  return {
    isFile: stat.kind === "file",
    isDirectory: stat.kind === "directory",
    isSymbolicLink: false,
    mode: stat.kind === "directory" ? 0o755 : 0o644,
    size: stat.size,
    mtime: new Date(stat.mtimeMs),
  };
}

function bytes(content: string | Uint8Array, encoding?: string): Uint8Array {
  if (typeof content !== "string") return content;
  if (encoding === "binary" || encoding === "latin1")
    return Uint8Array.from(content, (c) => c.charCodeAt(0) & 0xff);
  return encoder.encode(content);
}

export class VfsBashFs implements IFileSystem {
  readonly tooLarge = new Set<string>();

  constructor(private readonly vfs: Vfs) {}

  private whole(path: string) {
    return this.vfs.readFile(path).catch((error) => {
      if (error instanceof VfsError && error.code === "too_large")
        this.tooLarge.add(error.path);
      throw error;
    });
  }

  readFile(path: string, options?: { encoding?: string | null } | string) {
    return wrap("open", path, async () => {
      const data = await this.whole(path);
      const encoding =
        typeof options === "string" ? options : options?.encoding;
      if (encoding === "binary" || encoding === "latin1")
        return new TextDecoder("latin1").decode(data);
      return new TextDecoder().decode(data);
    });
  }
  readFileBuffer(path: string) {
    return wrap("open", path, () => this.whole(path));
  }
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string } | string,
  ) {
    const encoding = typeof options === "string" ? options : options?.encoding;
    return wrap("open", path, () =>
      this.vfs.writeFile(path, bytes(content, encoding)),
    );
  }
  appendFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string } | string,
  ) {
    const encoding = typeof options === "string" ? options : options?.encoding;
    return wrap("open", path, () =>
      this.vfs.appendFile(path, bytes(content, encoding)),
    );
  }
  exists(path: string) {
    return this.vfs.exists(path).catch(() => false);
  }
  stat(path: string) {
    return wrap("stat", path, async () => toStat(await this.vfs.stat(path)));
  }
  lstat(path: string) {
    return this.stat(path);
  }
  mkdir(path: string, options?: { recursive?: boolean }) {
    return wrap("mkdir", path, () => this.vfs.mkdir(path, options));
  }
  readdir(path: string) {
    return wrap("scandir", path, async () =>
      (await this.vfs.readdir(path)).map((e) => e.name),
    );
  }
  readdirWithFileTypes(path: string) {
    return wrap("scandir", path, async () =>
      (await this.vfs.readdir(path)).map((e) => ({
        name: e.name,
        isFile: e.kind === "file",
        isDirectory: e.kind === "directory",
        isSymbolicLink: false,
      })),
    );
  }
  rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return wrap("rm", path, () => this.vfs.rm(path, options));
  }
  cp(src: string, dest: string, options?: { recursive?: boolean }) {
    return wrap("cp", src, async () => {
      const stat = await this.vfs.stat(src);
      if (stat.kind === "file") return this.vfs.copyFile(src, dest);
      if (!options?.recursive) throw new VfsError("is_directory", src);
      await this.vfs.mkdir(dest, { recursive: true });
      for (const entry of await this.vfs.walk(src)) {
        const target = dest + entry.path.slice(normalizePath(src).length);
        if (entry.kind === "directory")
          await this.vfs.mkdir(target, { recursive: true });
        else await this.vfs.copyFile(entry.path, target);
      }
    });
  }
  mv(src: string, dest: string) {
    return wrap("rename", src, () => this.vfs.rename(src, dest));
  }
  resolvePath(base: string, path: string) {
    return joinPath(base, path);
  }
  getAllPaths() {
    return [];
  }
  async chmod() {}
  async utimes() {}
  async symlink(_target: string, linkPath: string) {
    throw Object.assign(
      new Error(
        `ENOTSUP: symbolic links are not supported, symlink '${linkPath}'`,
      ),
      { code: "ENOTSUP" },
    );
  }
  async link(existingPath: string, newPath: string) {
    await this.cp(existingPath, newPath);
  }
  async readlink(path: string): Promise<string> {
    throw Object.assign(
      new Error(`EINVAL: invalid argument, readlink '${path}'`),
      { code: "EINVAL" },
    );
  }
  realpath(path: string) {
    return wrap("realpath", path, async () => (await this.vfs.stat(path)).path);
  }
}

export interface BashRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class VfsShell {
  private readonly fs: VfsBashFs;
  private readonly bash: Bash;

  constructor(vfs: Vfs) {
    this.fs = new VfsBashFs(vfs);
    this.bash = new Bash({
      fs: this.fs,
      cwd: "/",
      env: { HOME: "/", USER: "agent", TERM: "dumb" },
    });
  }

  async run(
    command: string,
    options: {
      cwd: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<BashRun> {
    this.fs.tooLarge.clear();
    const result = await this.bash.exec(command, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const notes = [...this.fs.tooLarge].map(
      (p) =>
        `neo: ${p} is over the shell's ${WHOLE_READ_MAX / 1024 / 1024} MB limit (it reads whole files); use the read tool with offset and limit\n`,
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr + notes.join(""),
      exitCode: result.exitCode,
    };
  }
}
