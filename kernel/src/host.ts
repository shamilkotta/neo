import type { Cells, CoordinatorLink } from "./links";
import { NeoAgent } from "./neo";
import { NeoCoordinator } from "./coordinator/coordinator";
import type { SqliteDatabase } from "./sql";
import type { BlobStore } from "./vfs/blobs";

export interface Alarm {
  set(at: number | undefined): void | Promise<void>;
}

export interface Capabilities {
  sockets: boolean;
  processes: boolean;
}

export interface AgentPorts {
  name: string;
  db: SqliteDatabase;
  blobs: BlobStore;
  alarm: Alarm;
  capabilities: Capabilities;
  coordinator(instance: string): CoordinatorLink;
  peers(instance: string): Cells;
  test?: import("./testing").TestRuntime;
  now?: () => number;
}

export interface CoordinatorPorts {
  name: string;
  db: SqliteDatabase;
  blobs: BlobStore;
  masterKey: CryptoKey;
  capabilities: Capabilities;
  cells(instance: string): Cells;
  timezone?: string;
  test?: boolean;
  now?: () => number;
}

export interface Address {
  instance: string;
  agentId: string;
}

export abstract class AgentHost {
  private runtime: NeoAgent | undefined;
  private opening: Promise<NeoAgent> | undefined;

  protected abstract ports(): Promise<AgentPorts>;

  open() {
    this.opening ??= this.ports().then(async (ports) => {
      this.runtime = await NeoAgent.open(ports);
      return this.runtime;
    });
    return this.opening;
  }

  get agent() {
    if (!this.runtime) throw new Error("The host is not open");
    return this.runtime;
  }

  async fetch(request: Request, address: Address) {
    const agent = await this.open();
    if (agent.state === "empty") await agent.claim(address);
    return agent.fetch(request);
  }

  async alarm() {
    await (await this.open()).wake();
  }

  async close() {
    if (!this.opening) return;
    const agent = await this.opening.catch(() => undefined);
    await agent?.close();
    this.runtime = undefined;
    this.opening = undefined;
  }
}

export abstract class CoordinatorHost {
  private runtime: NeoCoordinator | undefined;
  private opening: Promise<NeoCoordinator> | undefined;

  protected abstract ports(): Promise<CoordinatorPorts>;

  open() {
    this.opening ??= this.ports().then(async (ports) => {
      this.runtime = await NeoCoordinator.open(ports);
      return this.runtime;
    });
    return this.opening;
  }

  async named(instance: string) {
    const coordinator = await this.open();
    await coordinator.setInstance(instance);
    return coordinator;
  }

  async fetch(request: Request, instance: string) {
    return (await this.named(instance)).fetch(request);
  }
}
