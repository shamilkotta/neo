# Moving an instance

An instance (chats, memories, files, schedules, providers, and a turn that is running) can move
between hosts: Bun ↔ Bun, Bun ↔ Cloudflare, Cloudflare ↔ Cloudflare. It keeps its id. Each move
raises its `epoch` by one.

Run the CLI from the repo root:

```bash
neo=(bun run hosts/bun/src/cli.ts)
$neo --help
```

## Terms

- **Token**: an instance's API password (the `#token=` in its web chat URL).
  - Bun: `<dir>/token` (`~/.neo/token` by default), or `--token` / `NEO_TOKEN` given to `serve`.
  - Cloudflare: the Worker's `NEO_TOKEN` secret.
- **Passphrase**: any text you choose for one move. It encrypts the secrets (provider keys) inside
  the bundle. Use the same one to import. It isn't stored, and isn't needed after the import.
  Without one, the move works but the secrets are dropped (add the keys again).
- **Bundle**: a `.neo` file (gzipped). It holds the whole instance.
- **Target**: where the instance goes. It must be either:
  - a **new** instance (no chats, providers, memories or files): a fresh `neo serve --dir <new dir>`,
    or a new `/i/<name>` on Cloudflare; or
  - the host it **moved away from** (state `moved`): the instance comes back to the same URL.

  Any other target refuses the import (409) and stays as it was.

## States

| State    | Meaning                                                     |
| -------- | ----------------------------------------------------------- |
| `active` | Running.                                                    |
| `sealed` | Stopped for a move. Can be exported. `unseal` runs it again. |
| `moved`  | Retired. Never runs again (unless the instance moves back). |

`$neo status --url URL --token T` shows `state` and `epoch`.

## Commands

### `move`: the whole move in one step

```bash
$neo move --from URL --from-token T --to URL --to-token T [--passphrase P]
```

Steps: check the target → seal and export the source to a temporary file → import it on the
target → retire the source (`complete`) → delete the file.

If anything fails before the import finishes, the source is unsealed and keeps running. After the
import, the source stays sealed, never running again, so two copies never run at once.

### `export`: seal and save to a file

```bash
$neo export --url URL --token T --out FILE [--passphrase P]
```

The instance stops (`sealed`) and is written to `FILE`. Next: `import` the file elsewhere, then
`complete`, or `unseal` to cancel. If the export fails, the instance is unsealed.

### `import`: load a file on the target

```bash
$neo import --url URL --token T FILE [--passphrase P]
```

Prints `{ instanceId, epoch, secrets }`. `secrets` is `"kept"` (with a passphrase) or `"dropped"`.
A running turn from the source resumes here.

Refused, with the target unchanged:
- a wrong passphrase, or none for a bundle that has one;
- a damaged or cut-off file;
- a target that isn't new (or isn't this instance's old host).

### `complete`: retire the source

```bash
$neo complete --url URL --token T
```

Run it after the import worked. The source becomes `moved`; its API answers 409.

### `unseal`: cancel a move

```bash
$neo unseal --url URL --token T
```

The sealed source runs again. Use it if you won't import, or the import failed. Don't unseal after
the target is running: you'd have two copies.

## Environment

`--url`, `--token` and `--passphrase` can come from `NEO_URL`, `NEO_TOKEN` and `NEO_PASSPHRASE`.

## Examples

Cloudflare → this machine:

```bash
bun run neo serve --dir ~/.neo-cf --port 7420        # terminal 1: a new local instance
$neo move \
  --from https://<worker>/i/main --from-token <cf token> \
  --to http://127.0.0.1:7420 --to-token "$(cat ~/.neo-cf/token)" \
  --passphrase <any text>
```

Back to Cloudflare (same URL): swap `--from` and `--to`, and their tokens.

Step by step, keeping a bundle file:

```bash
$neo export   --url https://<worker>/i/main --token <cf token> --out ~/main.neo --passphrase P
$neo import   --url http://127.0.0.1:7420 --token <local token> --passphrase P ~/main.neo
$neo complete --url https://<worker>/i/main --token <cf token>
```

## API

The same steps over HTTP (`Authorization: Bearer <token>`); `NeoClient` has a method for each.

| Route                    | Body                                                  | Client                     |
| ------------------------ | ----------------------------------------------------- | -------------------------- |
| `POST /v1/move/seal`     | `{}`                                                  | `seal()`                   |
| `POST /v1/move/export`   | `{ "passphrase"?: "P" }` → the bundle stream          | `exportBundle(P?)`         |
| `POST /v1/move/import`   | the bundle; header `x-neo-passphrase: P` (optional)   | `importBundle(bundle, P?)` |
| `POST /v1/move/complete` | `{}`                                                  | `complete()`               |
| `POST /v1/move/unseal`   | `{}`                                                  | `unseal()`                 |
