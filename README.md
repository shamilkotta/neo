# Neo

A minimal, always-on personal agent. The same kernel runs on Bun (laptop, VPS, VM, container) and in a
Cloudflare Durable Object, uses any model provider, and keeps everything in one SQLite database plus a
blob store, so an instance can later move between hosts. See [PLAN.md](PLAN.md).

Layout: `kernel/` (the core), `hosts/bun` and `hosts/cf` (where it runs), `apps/web` (the web chat),
`packages/client` (the API types and a typed client for every app), `e2e/` (one suite for every host).

## Run on a device (Bun)

```bash
bun install
bun run neo serve              # builds the web app, then serves it + the API; data in ~/.neo
```

Open the printed `web chat` URL (it carries the token once), add a provider in the panel, and chat.

## Run on Cloudflare

```bash
cd hosts/cf
openssl rand -base64 32 | bunx wrangler secret put NEO_MASTER_KEY
bunx wrangler secret put NEO_TOKEN
bunx wrangler r2 bucket create neo-blobs
bun run deploy                 # builds the web app into the Worker; an instance is https://<worker>/i/<name>/
bun run types                  # after editing wrangler.jsonc
```

Locally: put `NEO_MASTER_KEY` and `NEO_TOKEN` in `hosts/cf/.dev.vars`, then `bun run dev:cf`.

## The web app

`apps/web` (React + Vite, through `@neo/client`) is used two ways, from the same code:

- **Bundled (default):** every host build includes it and serves it next to the API (`/v1/*` is the
  API, everything else the app), so a new user needs nothing else. It calls the API where it was
  loaded from (`/i/<name>` on Cloudflare included).
- **Standalone:** set the API at build time and deploy `dist/` anywhere (Pages, any static host):
  `VITE_NEO_API_URL=https://<worker>/i/<name> bun run build:web`. The token is entered in the app
  (never baked in). The API allows cross-origin calls; it is authorized by the bearer token only.

Developing it: `bun run neo serve` in one terminal, `bun run dev:web` in another (Vite proxies
`/v1` to `127.0.0.1:7420`; set `NEO_DEV_API` for another instance).

## Test

```bash
bun run test                   # builds the web app, then the suite on an in-process Bun host
# the same suite on a Durable Object: in hosts/cf, `bun run dev -- --port 8799 --var NEO_TEST:1`
# with NEO_TOKEN=t in .dev.vars, then:
bun run test:cf
```

`NEO_TEST=1` swaps in a scripted model (`@neo/kernel/testing`), so tests drive turns exactly.

## API (JSON, `Authorization: Bearer <token>`)

| Area | Routes |
| --- | --- |
| Instance | `GET /v1/status`, `GET /v1/events?after=` (SSE: durable events with ids, plus `live` turn deltas). Any origin (CORS); token in the header only. |
| Conversation | `POST /v1/messages` `{text, clientId?, steer?}`, `GET /v1/transcript?before=&limit=`, `GET /v1/live`, `GET /v1/turns/:id`, `POST /v1/stop`, `/v1/pause`, `/v1/resume` |
| Queue | `GET /v1/queue`, `PATCH/DELETE /v1/queue/:id`, `POST /v1/queue/:id/steer`, `PUT /v1/queue/order` |
| Memory | `GET /v1/memories?q=`, `POST /v1/memories`, `PATCH/DELETE /v1/memories/:id` |
| Wake-ups | `GET/POST /v1/wakeups`, `DELETE /v1/wakeups/:id` |
| Agent | `GET/PATCH /v1/agent` (name, instructions, model, thinking, heartbeat), `GET/PUT /v1/settings` |
| Models | `GET /v1/providers`, `PUT/DELETE /v1/providers/:id`, `GET /v1/providers/detect`, `GET /v1/models` |
| Files | `GET/PUT/DELETE /v1/files?path=` |
