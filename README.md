# Hack Club AI, next generation

This repository is the replacement Hack Club AI gateway and dashboard. It uses
Elysia and Bun, with a SvelteKit dashboard built on shadcn-svelte.

## Local datastores

Copy the development environment and start PostgreSQL 18 and ClickHouse 26.2:

```bash
cp .env.example .env
bun run db:up
```

The default endpoints are:

- PostgreSQL: `postgres://hcai:hcai@localhost:55432/hcai`
- ClickHouse HTTP: `http://localhost:8123`
- ClickHouse native protocol: `localhost:9000`

In production the server refuses to start unless `CLICKHOUSE_URL`,
`CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` are set explicitly; the
compose defaults above are for local development only, and compose binds
both datastores to `127.0.0.1`.

Schema changes are SQL files in `migrations/postgres` and
`migrations/clickhouse`, applied by [dbmate](https://github.com/amacneil/dbmate)
through `bun run db:migrate` (which `bun run db:up` also runs). Each file
starts with `-- migrate:up` and ends with an empty `-- migrate:down`
(migrations are forward-only). Each Postgres file runs in one transaction.
ClickHouse accepts one statement per query, so each ClickHouse file holds
exactly one statement, and since ClickHouse DDL is not transactional that
statement must be idempotent (`IF NOT EXISTS`). `bun run db:migrate --status`
lists pending files (exit 2 if any), and `--only=postgres` or
`--only=clickhouse` limits a run to one store. Run `db:migrate` as a deploy
step before starting the server; the server logs a warning at startup if
files are pending but never applies them itself.

Useful commands:

```bash
bun run db:logs
bun run db:down
bun run db:reset # removes local database volumes
bun run db:check
```

`db:reset` is destructive and is intended only for local development.

The PostgreSQL integration tests (billing engine, metered requests, and the
HTTP proxy) are opt-in so the normal unit suite does not depend on Docker.
Stop `bun run dev` first: its job worker drains the queue the tests inspect.

CI (`.github/workflows/ci.yml`) runs the unit gates on every push and pull
request, then starts Postgres and ClickHouse with `docker compose` and runs
the same integration tests with the variables above set.

```bash
bun run test:integration            # everything, including the Docker-gated suites
bun run test:integration src/billing # a subset
```

By hand, the script does: start `bun run db:up`; create a second database
`hcai_test` on the same Postgres container
(`docker compose exec -T postgres psql -U hcai -d hcai -c "CREATE DATABASE hcai_test"`);
apply migrations to it (`DATABASE_URL=postgres://hcai:hcai@localhost:55432/hcai_test bun run db:migrate`);
then run `bun test` with `BILLING_TEST_DATABASE_URL`,
`ANALYTICS_TEST_DATABASE_URL`, and `ANALYTICS_TEST_CLICKHOUSE_URL` all set to
that database and ClickHouse.

The tests refuse to run when the test URL is the same database as
`DATABASE_URL`.

The outbox delivery test additionally inserts an outbox row, drains it to
ClickHouse, and checks the event is searchable
(`bun run test:integration src/analytics/request-events.integration.test.ts`).

## Development server

```bash
bun install --frozen-lockfile
cp .env.example .env   # fill in OPENROUTER_API_KEY and any provider keys
bun run db:up          # PostgreSQL 18 + ClickHouse 26.2 via Docker
bun run dev:seed       # local user, API key, and browser session (dev only)
bun run dev            # http://localhost:3000
```

`dev:seed` prints an API key for the proxy and a cookie that signs you into
the dashboard without Hack Club OAuth. Providers are enabled by their keys:
`/proxy/v1/replicate/*` is mounted only when `REPLICATE_API_KEY` is set, and
Exa and OCR answer `503` with "<Provider> is not configured" until
`EXA_API_KEY` / `MISTRAL_API_KEY` are set. `TYPESAFE_API_KEY` is different:
unlike the other provider keys, it is required at startup for the Jev route.
`bun run dev:reset-db` wipes the local databases and re-applies the
migrations.

The server needs `DATABASE_URL` and `OPENROUTER_API_KEY`; see `.env.example`
for the optional settings. On startup it creates the Graphile Worker schema,
starts the in-process ClickHouse delivery worker, and listens on `PORT`.
Error reporting goes to Sentry when `SENTRY_DSN` is set (`sendDefaultPii`
is off, so bearer keys and cookies are never sent).

### HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /up` | none | Health: PostgreSQL, ClickHouse, OpenRouter key |
| `GET /proxy/v1/models` | none | Full OpenRouter model listing (language + embedding); no allowlist |
| `POST /proxy/v1/chat/completions`, `/responses`, `/embeddings` | API key | OpenAI-compatible proxy |
| `POST /proxy/v1/images/generations` | API key | Image generation via OpenRouter |
| `POST /proxy/v1/moderations` | API key | OpenAI moderation pass-through (unbilled) |
| `POST /proxy/v1/exa/*` | API key (503 until `EXA_API_KEY` is set) | Exa search, contents, answer |
| `POST /proxy/v1/ocr` | API key (503 until `MISTRAL_API_KEY` is set) | Mistral OCR |
| `/proxy/v1/replicate/*` | API key (mounted only when `REPLICATE_API_KEY` is set) | Replicate files, models, predictions (scoped to their creator; no account-wide listings) |
| `POST /proxy/v1/jev/systemone`, `GET /proxy/v1/jev/models` (also under `/jev/v1/`) | API key | Jev (Typesafe) system prompt one-shot; `TYPESAFE_API_KEY` is required at startup |
| `/auth/login`, `/auth/callback`, `POST /auth/logout` | cookie | Hack Club sign-in |
| `GET/POST /api/keys`, `DELETE /api/keys/:id`, `POST /api/dismiss-agent-banner` | session | Dashboard key management |
| `POST /api/ghss`, `POST /internal/revoke` | signature / shared secret | Leaked-key revocation |

Requests authenticate with `Authorization: Bearer sk-hc-v1-...`. Bodies pass
through to the provider unchanged apart from `user` and `usage.include`. Errors
use the previous gateway's `{ "error": "message" }` shape, with `429` when the
account's funding or a limit policy cannot cover the reservation. Known coding
agents and chat frontends are refused with the previous gateway's message.
Allowlists apply only to `/images/generations` (`ALLOWED_IMAGE_MODELS`) and
`/replicate/*` (`src/config/replicate-models.ts`).

Every metered request is reserved before dispatch and finalized from the
provider's reported cost; uncertain outcomes are reconciled by a five-minute
Graphile Worker cron (see `docs/architecture/storage-and-billing.md`).

### Not carried over

- Per-user OpenRouter provisioned keys: limits are enforced by our ledger.
- Exa streaming responses (`stream: true` is rejected with 400).
- The rate limiter is process-local, as before.

## Dashboard

The site is a SvelteKit app (SvelteKit 3 pre-release with the official Bun
adapter, Svelte 5, Tailwind v4 built at compile time). Its server hook embeds
the same Elysia backend used by `src/index.ts`: requests under `/proxy`,
`/api`, `/auth`, `/internal`, and `/up` are answered by Elysia without going
through SvelteKit routing, so streaming and cancellation behave exactly as in
the standalone API. Pages read the session cookie and query PostgreSQL and
ClickHouse directly through `locals.backend`.

```bash
bun run dev            # Vite dev server with HMR
bun run --bun build    # production build into ./build (must run under Bun)
bun run start          # bun ./build
bun run check          # svelte-check
```

> The built server accepts request bodies up to 20 MiB by default. Set
> `BODY_SIZE_LIMIT` (for example `BODY_SIZE_LIMIT=20M`) to change it at
> runtime; the standalone API reads `MAX_REQUEST_BODY_BYTES` instead. Keep the
> two equal.

Pages: `/` (marketing, redirects signed-in users), `/dashboard`, `/keys`,
`/activity` (with cursor-paged "Load more"), `/models`, `/models/<id>`,
`/global`, `/replicate`, `/jev`, `/exa`, and `/ocr`.
Sign-in uses Hack Club OAuth at `/auth/login`; without `HACK_CLUB_CLIENT_ID`
and `HACK_CLUB_CLIENT_SECRET` the auth routes are not mounted.

Conventions specific to SvelteKit 3: shared code lives in `src/lib` and is
imported as `#lib/<path>.ts` (explicit extension; the `$lib` alias was removed
upstream), `src/env.ts` must export `variables` because SvelteKit reserves that
file for its env schema, and `src/kit.d.ts` holds the `App.Locals` types.

## Architecture

See `docs/architecture/storage-and-billing.md` for datastore ownership,
billing invariants, retention, and body-search decisions.
