#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "./server";

const HELP = `neo: a minimal always-on agent

  neo serve  [--dir ~/.neo] [--port 7420] [--hostname 127.0.0.1]
             Run this device's instance. Open the printed URL for the web chat.
  neo status --url URL --token T

Env: NEO_DIR, NEO_PORT, NEO_TOKEN, NEO_MASTER_KEY, NEO_TEST=1 (scripted test model).`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    dir: { type: "string" },
    port: { type: "string" },
    hostname: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

async function main() {
  const [command] = positionals;
  if (!command || values.help) return console.log(HELP);
  switch (command) {
    case "serve": {
      const dir = values.dir ?? process.env.NEO_DIR ?? join(homedir(), ".neo");
      const running = await serve({
        dir,
        port: Number(values.port ?? process.env.NEO_PORT ?? 7420),
        ...(values.hostname ? { hostname: values.hostname } : {}),
        ...(values.token ? { token: values.token } : {}),
        test: process.env.NEO_TEST === "1",
      });
      console.log(`neo ${running.neo.state} on ${running.url} (data in ${dir})`);
      console.log(`web chat: ${running.url}/#token=${running.token}`);
      const stop = async () => {
        await running.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "status": {
      const url = values.url ?? process.env.NEO_URL;
      const token = values.token ?? process.env.NEO_TOKEN;
      if (!url || !token) throw new Error("--url and --token are required");
      const response = await fetch(`${url.replace(/\/$/, "")}/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return console.log(JSON.stringify(await response.json(), null, 2));
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
