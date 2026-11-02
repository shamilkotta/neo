# Neo

A minimal, always-on personal agent, and a team of them: each agent is its own Cloudflare Durable
Object (its own SQLite, chat, memory, schedules and files); a coordinator Durable Object holds what they
share (the agent list, providers and keys, the model, settings, `/shared`). Agents talk to each other
directly. Any model provider; the whole instance moves as one bundle. See [PLAN.md](PLAN.md) and
[docs/MULTI-AGENT.md](docs/MULTI-AGENT.md). (On branch `v2` the Bun host is out of scope.)

Layout: `kernel/` (the core), `hosts/bun` and `hosts/cf` (where it runs), `apps/web` (the web chat),
`packages/client` (the API types and a typed client for every app), `e2e/` (one suite for every host).

## Run on Cloudflare

```bash
cd hosts/cf
openssl rand -base64 32 | bunx wrangler secret put NEO_MASTER_KEY
bunx wrangler secret put NEO_TOKEN
bunx wrangler r2 bucket create neo-blobs
bun run deploy                 # builds the web app into the Worker: the app is https://<worker>/, the API https://<worker>/i
bun run types                  # after editing wrangler.jsonc
```

Locally: put `NEO_MASTER_KEY` and `NEO_TOKEN` in `hosts/cf/.dev.vars`, then `bun run dev:cf`.

## Move an instance

Seal, export, import, complete: [docs/MOVING.md](docs/MOVING.md).

## The web app

`apps/web` (React + Vite, through `@neo/client`) is used two ways, from the same code:

- **Bundled (default):** the Worker serves it at every path but `/i/…` (the API), so a new user
  needs nothing else. It calls `/i` where it was loaded from.
- **Standalone:** set the API at build time and deploy `dist/` anywhere (Pages, any static host):
  `VITE_NEO_API_URL=https://<worker>/i bun run build:web`. The token is entered in the app
  (never baked in). The API allows cross-origin calls; it is authorized by the bearer token only.

Developing it: `bun run dev:cf` in one terminal, `bun run dev:web` in another (Vite proxies `/i` to
`127.0.0.1:8787`; set `NEO_DEV_API` for another address).

## Test

```bash
# in hosts/cf: NEO_MASTER_KEY and NEO_TOKEN=t in .dev.vars, then
bun run build:web && bunx wrangler dev --port 8799 --var NEO_TEST:1
bun run test:cf                # the e2e suite; each test gets its own instance
```

`NEO_TEST=1` swaps in a scripted model (`@neo/kernel/testing`), so tests drive turns exactly.

## API (JSON, `Authorization: Bearer <token>`, any origin)

The instance is `/i`; one agent is `/i/agents/<id>`. `NeoClient({ url: "https://<worker>/i" })` and
`client.agent(id)` cover both.

| Where    | Routes                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance | `GET /i/status`, `GET /i/events` (SSE), `GET/POST /i/agents`, `GET/PATCH/DELETE /i/agents/:id`, `GET/PUT /i/settings` (timezone, model, thinking), `GET/PUT/DELETE /i/providers/:id`, `GET /i/providers/detect`, `GET /i/models`, `POST /i/move/*`                                                                                                                               |
| Agent    | `GET …/status`, `GET …/events` (SSE), `GET …/agent`, `POST …/messages`, `GET …/transcript`, `GET …/live`, `GET …/turns/:id`, `POST …/stop`, `…/pause`, `…/resume`, `GET …/queue`, `PATCH/DELETE …/queue/:id`, `POST …/queue/:id/steer`, `PUT …/queue/order`, `GET …/schedules`, `PATCH …/schedules/:id`, `POST …/uploads`, `GET/DELETE …/files?path=`, `GET …/attachments?path=` |
