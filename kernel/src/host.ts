import type { SqliteDatabase } from "./sql";
import type { BlobStore } from "./vfs/blobs";
import { Neo } from "./neo";

/**
 * The host's one timer. The host only owns the primitive (setTimeout, a Durable Object alarm); the
 * kernel decides when it rings (`Neo.arm`) and what runs then (`Neo.wake`). A later `set` replaces
 * the earlier one; `undefined` clears it.
 */
export interface Alarm {
  set(at: number | undefined): void | Promise<void>;
}

/** What a host can do beyond the ports. The kernel turns tools on and off to match; state never depends on it. */
export interface Capabilities {
  /** Keeps sockets open between requests (Bun). A Durable Object hibernates instead. */
  sockets: boolean;
  /** Runs real processes (later: a real shell, stdio MCP). */
  processes: boolean;
}

/**
 * Everything the kernel needs from a host. A new platform (Node, Deno, ...) implements these and
 * passes the host conformance suite in `@neo/kernel/testing`.
 */
export interface HostPorts {
  /** "bun", "cloudflare", ...: shown in status and, later, in bundles. */
  name: string;
  /** The instance database. Neo's tables and Pi's (`pi_*`) share it and commit together. */
  db: SqliteDatabase;
  /** The bytes of large files (a folder on disk, R2). The database keeps their keys. */
  blobs: BlobStore;
  alarm: Alarm;
  /** Wraps the instance's data key at rest on this host. It never leaves the host. */
  masterKey: CryptoKey;
  /** Bearer token for the API. */
  token: string;
  capabilities: Capabilities;
  /** The host's own timezone, the default for a new instance. */
  timezone?: string;
  /** Test mode: the scripted model and tools (`@neo/kernel/testing`). */
  test?: import("./testing").TestRuntime;
  now?: () => number;
}

/**
 * The base of every host. A host implements `ports()` and calls `open()`; it forwards requests to
 * `fetch()` and its timer to `alarm()`. Everything else (when to wake, the recovery heartbeat,
 * starting and stopping the runtime) is here, once, so hosts stay small and behave the same.
 */
export abstract class NeoHost {
  private runtime: Neo | undefined;
  private opening: Promise<Neo> | undefined;

  /** Builds this host's ports. Called once, by `open()`. */
  protected abstract ports(): Promise<HostPorts>;

  /** Opens the instance on this host (idempotent). */
  open(): Promise<Neo> {
    this.opening ??= this.ports().then(async (ports) => {
      this.runtime = await Neo.open(ports);
      return this.runtime;
    });
    return this.opening;
  }

  get neo(): Neo {
    if (!this.runtime) throw new Error("The host is not open");
    return this.runtime;
  }

  async fetch(request: Request): Promise<Response> {
    return (await this.open()).fetch(request);
  }

  /** The host's timer rang. */
  async alarm(): Promise<void> {
    await (await this.open()).wake();
  }

  async close(): Promise<void> {
    if (!this.opening) return;
    const neo = await this.opening.catch(() => undefined);
    await neo?.close();
    this.runtime = undefined;
    this.opening = undefined;
  }
}
