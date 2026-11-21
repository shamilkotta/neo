#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NeoClient } from "@neo/client";

const HELP = `neo: a minimal always-on agent

  neo status --url URL --token T

Moving an instance to a new, empty instance. A passphrase carries the secrets
(provider keys); without one they are dropped.

  neo move   --from URL --from-token T --to URL --to-token T [--passphrase P]
             Seal, export, import on the target, retire the source. On failure the source runs again.
  neo export --url URL --token T --out FILE [--passphrase P]
             Seal and export. Then "neo complete" once imported elsewhere, or "neo unseal".
  neo import --url URL --token T FILE [--passphrase P]
  neo complete --url URL --token T     Retire a sealed, exported source.
  neo unseal   --url URL --token T     Cancel a move: the source runs again.

Env: NEO_URL, NEO_TOKEN, NEO_PASSPHRASE.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    from: { type: "string" },
    "from-token": { type: "string" },
    to: { type: "string" },
    "to-token": { type: "string" },
    out: { type: "string" },
    passphrase: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function target(): NeoClient {
  const url = values.url ?? process.env.NEO_URL;
  const token = values.token ?? process.env.NEO_TOKEN;
  if (!url || !token) throw new Error("--url and --token are required");
  return new NeoClient({ url, token });
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main() {
  const [command, ...rest] = positionals;
  const passphrase = values.passphrase ?? process.env.NEO_PASSPHRASE;
  if (!command || values.help) return console.log(HELP);
  switch (command) {
    case "status":
      return print(await target().status());
    case "export": {
      const neo = target();
      if (!values.out) throw new Error("--out is required");
      await neo.seal();
      try {
        await Bun.write(
          values.out,
          new Response(await neo.exportBundle(passphrase)),
        );
      } catch (error) {
        await neo.unseal();
        throw error;
      }
      return console.log(
        `Exported to ${values.out}. The source is sealed: run "neo complete" after the import, or "neo unseal".`,
      );
    }
    case "import": {
      const file = rest[0];
      if (!file) throw new Error("Give the bundle file");
      return print(await target().importBundle(Bun.file(file), passphrase));
    }
    case "move": {
      const { from, to } = values;
      const fromToken = values["from-token"];
      const toToken = values["to-token"];
      if (!from || !fromToken || !to || !toToken)
        throw new Error(
          "--from, --from-token, --to and --to-token are required",
        );
      const source = new NeoClient({ url: from, token: fromToken });
      const dest = new NeoClient({ url: to, token: toToken });
      const before = await dest.status();
      if (before.state === "sealed")
        throw new Error(
          `The target can't take an import (it is ${before.state})`,
        );
      await source.seal();
      const spool = mkdtempSync(join(tmpdir(), "neo-move-"));
      const file = join(spool, "instance.neo");
      let imported = false;
      try {
        await Bun.write(
          file,
          new Response(await source.exportBundle(passphrase)),
        );
        const result = await dest.importBundle(Bun.file(file), passphrase);
        imported = true;
        await source.complete();
        print({ moved: result });
      } catch (error) {
        if (!imported) await source.unseal().catch(() => {});
        throw error;
      } finally {
        rmSync(spool, { recursive: true, force: true });
      }
      return;
    }
    case "complete":
      return print(await target().complete());
    case "unseal":
      return print(await target().unseal());
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
