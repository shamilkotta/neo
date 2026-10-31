import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  dir: string;
  token?: string;
  test?: boolean;
}

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
        process.env.NEO_MASTER_KEY ??
          hostSecret(join(dir, "master.key"), newMasterKeyBase64),
      ),
      token: this.token,
      capabilities: { sockets: true, processes: false },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      ...(this.options.test ? { test: createTestRuntime() } : {}),
    };
  }

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

function hostSecret(path: string, create: () => string): string {
  if (!existsSync(path)) {
    writeFileSync(path, `${create()}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, "utf8").trim();
}
