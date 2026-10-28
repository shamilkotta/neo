import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRuntime } from "@neo/kernel/testing";
import {
  type HostPorts,
  masterKeyFromBase64,
  NeoHost,
  newMasterKeyBase64,
  randomToken,
} from "@neo/kernel";
import { BunAlarm } from "./alarm";
import { BunBlobs } from "./blobs";
import { type BunSqlite, openBunSqlite } from "./sqlite";

export interface BunHostOptions {
  /** Holds neo.db, blobs/, master.key and token. */
  dir: string;
  /** Overrides the token file (or NEO_TOKEN). */
  token?: string;
  /** The scripted test model (NEO_TEST=1). */
  test?: boolean;
}

/**
 * A Neo instance on Bun: a laptop, a VPS, a VM or a container. Its data is one folder:
 * `neo.db` (the instance), `blobs/` (large file bytes), and this host's own `master.key` and
 * `token`, which never travel with the instance.
 */
export class BunHost extends NeoHost {
  private db: BunSqlite | undefined;
  private timer: BunAlarm | undefined;

  constructor(readonly options: BunHostOptions) {
    super();
  }

  protected async ports(): Promise<HostPorts> {
    const { dir } = this.options;
    mkdirSync(dir, { recursive: true });
    this.db = openBunSqlite(join(dir, "neo.db"));
    this.timer = new BunAlarm(() => this.alarm());
    return {
      name: "bun",
      db: this.db,
      blobs: new BunBlobs(join(dir, "blobs")),
      alarm: this.timer,
      masterKey: await masterKeyFromBase64(
        process.env.NEO_MASTER_KEY ?? hostSecret(join(dir, "master.key"), newMasterKeyBase64),
      ),
      token: this.token,
      capabilities: { sockets: true, processes: false },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      ...(this.options.test ? { test: createTestRuntime() } : {}),
    };
  }

  /** The API token: the option, NEO_TOKEN, or this host's token file (created on first start). */
  get token(): string {
    return (
      this.options.token ??
      process.env.NEO_TOKEN ??
      hostSecret(join(this.options.dir, "token"), () => randomToken())
    );
  }

  override async close(): Promise<void> {
    await super.close();
    this.timer?.close();
    await this.db?.close();
  }
}

/** A file this host keeps for itself (never part of the instance), created on first use. */
function hostSecret(path: string, create: () => string): string {
  if (!existsSync(path)) {
    writeFileSync(path, `${create()}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, "utf8").trim();
}
