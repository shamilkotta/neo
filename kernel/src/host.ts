import type { SqliteDatabase } from "./sql";
import type { BlobStore } from "./vfs/blobs";
import { Neo } from "./neo";

export interface Alarm {
  set(at: number | undefined): void | Promise<void>;
}

export interface Capabilities {
  sockets: boolean;
  processes: boolean;
}

export interface HostPorts {
  name: string;
  db: SqliteDatabase;
  blobs: BlobStore;
  alarm: Alarm;
  masterKey: CryptoKey;
  token: string;
  capabilities: Capabilities;
  timezone?: string;
  test?: import("./testing").TestRuntime;
  now?: () => number;
}

export abstract class NeoHost {
  private runtime: Neo | undefined;
  private opening: Promise<Neo> | undefined;

  protected abstract ports(): Promise<HostPorts>;

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
