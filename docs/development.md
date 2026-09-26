# Development

## Running locally

```bash
bun install --frozen-lockfile
git submodule update --init   # maintainers only: private anti-abuse rules
cp .env.example .env          # fill in every provider key; all are required
bun run db:up                 # PostgreSQL 18, ClickHouse 26.2 and Garage via Docker
bun run dev                   # http://localhost:3000
```

Sign in through Hack Club OAuth. Every provider is always mounted, so the
server refuses to start unless all of their keys are set:
`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `HACK_CLUB_CLIENT_ID`,
`HACK_CLUB_CLIENT_SECRET`, `OPENAI_MODERATION_API_KEY`, `MISTRAL_API_KEY`,
`EXA_API_KEY` and `REPLICATE_API_KEY`. It also needs `DATABASE_URL`; see
`.env.example` for the optional settings.

On startup the server creates the Graphile Worker schema, starts the
in-process ClickHouse delivery worker, and listens on `PORT`. Error reporting
goes to Sentry when `SENTRY_DSN` is set (`sendDefaultPii` is off, so bearer
keys and cookies are never sent).

| Command | What it does |
|---|---|
| `bun run dev` | Vite dev server with HMR (dashboard and API) |
| `bun run api` | Standalone API only |
| `bun run typecheck` / `bun run check` | TypeScript and svelte-check |
| `bun run build` then `bun run start` | Production build into `./build`, then run it |
| `bun run db:logs` / `db:down` | Datastore logs / stop the datastores |
| `bun run db:reset` | Remove the local database volumes (destructive) |
| `bun run dev:reset-db` | Wipe the local databases and re-apply migrations |

### Local datastores

- PostgreSQL: `postgres://hcai:hcai@localhost:55432/hcai`
- ClickHouse HTTP: `http://localhost:8123`, native protocol `localhost:9000`
- Garage S3 API: `http://localhost:3900`, bucket `request-blobs`

Compose binds every datastore to `127.0.0.1`; its credentials are for local
development only.

## Tests

`bun test` runs every suite against real PostgreSQL 18, ClickHouse and Garage,
including the billing engine; nothing is faked except upstream providers.
Start the datastores first:

```bash
bun run db:up
bun test
bun test src/billing # a subset
```

Each run clones its own PostgreSQL database from a migrated template and
creates a ClickHouse database of the same name, then drops both, so
`bun run dev` can keep running. The template is rebuilt when a migration
changes (the first run afterwards takes about 20 seconds). With no reachable
server the run fails before any test: it never skips.

To use other servers, set `TEST_DATABASE_URL` (a PostgreSQL 18 server whose
role can create databases) and `TEST_CLICKHOUSE_URL`, `TEST_CLICKHOUSE_USER`,
`TEST_CLICKHOUSE_PASSWORD`. CI (`.github/workflows/ci.yml`) starts the
datastores with `docker compose` and runs the same `bun test`.

## Migrations

Schema changes are SQL files in `migrations/postgres` and
`migrations/clickhouse`, applied by [dbmate](https://github.com/amacneil/dbmate)
through `bun run db:migrate` (which `bun run db:up` also runs). Each file
starts with `-- migrate:up` and ends with an empty `-- migrate:down`
(migrations are forward-only). Each PostgreSQL file runs in one transaction.
ClickHouse accepts one statement per query and its DDL is not transactional,
so each ClickHouse file holds exactly one idempotent statement
(`IF NOT EXISTS`).

`bun run db:migrate --status` lists pending files (exit 2 if any), and
`--only=postgres` or `--only=clickhouse` limits a run to one store.
`bun run start` runs `db:migrate` before the server; its advisory lock makes
concurrent replicas safe. The server never applies migrations itself: it
refuses to start while PostgreSQL files are pending.

## Production

The server refuses to start unless `CLICKHOUSE_URL`, `CLICKHOUSE_USER`,
`CLICKHOUSE_PASSWORD`, `BLOB_STORE_URL`, `BLOB_STORE_ACCESS_KEY_ID` and
`BLOB_STORE_SECRET_ACCESS_KEY` are set explicitly.

The blob bucket must expire objects so blobs leave with the bodies that
reference them (90-day TTL, plus a day of slack):

```bash
aws s3api put-bucket-lifecycle-configuration --endpoint-url "$BLOB_STORE_URL" \
  --bucket request-blobs --lifecycle-configuration \
  '{"Rules":[{"ID":"body-ttl","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":91}}]}'
```

The built server accepts request bodies up to 20 MiB by default. Set
`BODY_SIZE_LIMIT` (for example `BODY_SIZE_LIMIT=20M`) to change it; the
standalone API reads `MAX_REQUEST_BODY_BYTES` instead. Keep the two equal.

## How it fits together

The dashboard is a SvelteKit app (SvelteKit 3 with the Bun adapter, Svelte 5,
Tailwind v4). Its server hook embeds the same Elysia backend as
`src/index.ts`: requests under `/proxy`, `/api`, `/auth`, `/internal` and
`/up` are answered by Elysia without going through SvelteKit routing, so
streaming and cancellation behave exactly as in the standalone API.

Requests authenticate with `Authorization: Bearer sk-hc-v1-...`. Bodies pass
through to the provider unchanged apart from `user` and `usage.include`.
Errors are `{ "error": "message" }`, with `429` when the account's funding or
a limit policy cannot cover the reservation. Allowlists apply only to
`/images/generations` (`ALLOWED_IMAGE_MODELS`) and `/replicate/*`
(`src/config/replicate-models.ts`).

Every metered request is reserved before dispatch and finalized from the
provider's reported cost; uncertain outcomes are reconciled by a five-minute
Graphile Worker cron. See
[`architecture/storage-and-billing.md`](architecture/storage-and-billing.md).

| Route | Auth | Purpose |
|---|---|---|
| `GET /up` | none | Health: PostgreSQL, ClickHouse, OpenRouter key |
| `GET /proxy/v1/models` | none | OpenRouter model listing (language and embedding) |
| `POST /proxy/v1/chat/completions`, `/responses`, `/embeddings` | API key | OpenAI-compatible proxy |
| `POST /proxy/v1/images/generations` | API key | Image generation via OpenRouter |
| `POST /proxy/v1/moderations` | API key | OpenAI moderation pass-through (unbilled) |
| `POST /proxy/v1/exa/*` | API key | Exa search, contents, answer |
| `POST /proxy/v1/ocr` | API key | Mistral OCR |
| `/proxy/v1/replicate/*` | API key | Replicate files, models, predictions (scoped to their creator) |
| `POST /proxy/v1/jev/systemone`, `GET /proxy/v1/jev/models` | API key | Jev (TypeSafe) |
| `/auth/login`, `/auth/callback`, `POST /auth/logout` | cookie | Hack Club sign-in |
| `GET/POST /api/keys`, `DELETE /api/keys/:id`, `POST /api/dismiss-agent-banner` | session | Dashboard key management |
| `POST /api/ghss`, `POST /internal/revoke` | signature / shared secret | Leaked-key revocation |
