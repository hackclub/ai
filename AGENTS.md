# Hack Club AI gateway — agent notes

Read this before changing anything. `README.md` covers setup;
`docs/architecture/storage-and-billing.md` covers the billing invariants;
`plans/README.md` lists pending improvement plans.

## Stack

Bun 1.4 · Elysia 2.0 pre-release (exact pin in `package.json`) · SvelteKit 3
`next` + `@sveltejs/adapter-bun` `next` · Svelte 5 runes · Tailwind v4 ·
TypeScript 6 · PostgreSQL 18 (`postgres` driver) · ClickHouse 26.2
(`@clickhouse/client`) · Garage 2.4 (S3 API via `Bun.S3Client`) · Graphile Worker.

Never run `bun update`, never change a framework version as a side effect of
another change, and always install with `bun install --frozen-lockfile`.
Elysia exp builds break between versions; bumping one is its own PR.
Version ranges in `package.json` are pinned exactly for `elysia`,
`bun-types` and `typescript`; the lockfile is authoritative for the rest.

## Commands

| Task | Command |
|---|---|
| Dev server (dashboard + API, HMR) | `bun run dev` → http://localhost:3000 |
| Standalone API only | `bun run api` |
| Typecheck (the baseline gate) | `bun run typecheck` |
| Svelte check | `bun run check` |
| Tests (needs `db:up`) | `bun test` |
| Production build / run | `bun run build` then `bun run start` |
| Local databases | `bun run db:up` / `db:down` / `db:logs` |
| Wipe local databases | `bun run db:reset` (destructive) |
| Apply migrations | `bun run db:migrate` (`--status` lists pending) |

Verification baseline for any change: `bun run typecheck` exits 0 and
`bun test` reports `0 fail`. `bun test` needs PostgreSQL 18, ClickHouse and Garage
running (`bun run db:up`, or `TEST_DATABASE_URL` / `TEST_CLICKHOUSE_URL` /
`TEST_BLOB_STORE_URL`) and fails before any test when one is unreachable;
nothing is skipped.
Each run creates and drops its own databases, so the dev server can keep
running (`src/test/database.ts`, `docs/adr/0001`).

## Layout

- `src/index.ts` — standalone API entrypoint.
- `src/hooks.server.ts` — SvelteKit hook; embeds the same Elysia app for
  `/up`, `/proxy/*`, `/api/*`, `/auth/*`, `/internal/*`. Backend lifecycle
  changes must be made in **both** entrypoints.
- `src/server.ts` — `createBackend(env)`: wires DB clients, billing, routes.
- `src/app.ts` — Elysia app assembly and the error → `{ error }` mapping.
- `src/gateway/` — Elysia routes. `proxy.ts` is the OpenAI-compatible proxy;
  `routes/*.ts` are the other providers; `routes/shared.ts` owns the helpers
  every provider route shares (auth, rate limit, JSON parsing, billing error
  mapping). Add shared behaviour there, not in a single route.
- `src/billing/` — read `src/billing/README.md` first. `engine.ts` is the
  only writer of `billing_*` tables; all money arithmetic is in the pure
  `plan.ts`, the state machine in `lifecycle.ts`. `money.ts` is the money
  type. `reconciliation.ts` settles uncertain reservations on a cron.
- `src/providers/` — upstream adapters. `metered-body.ts` meters every
  response body; each provider has a `provider.ts` module (cost extraction
  and its reconciliation lookup, or `null`), registered in `src/server.ts`.
  A new provider is a new module there, not a branch in `billing/`.
- `src/analytics/` — outbox → ClickHouse drainer and dashboard queries.
  `bodies.ts` compacts bodies on the way in (assembled streams, base64
  blobs moved to Garage); never write raw `data:` URLs to ClickHouse.
- `src/auth/` — API keys, sessions, Hack Club OAuth.
- `src/routes/` + `src/lib/` — SvelteKit pages and shared UI/server code.
- `migrations/postgres`, `migrations/clickhouse` — numbered SQL files.
- `secrets/` — the private `hackclub/ai-secrets` submodule: anti-abuse rules
  (`abuse.json`: blocked apps, User-Agents, prompts, tool fingerprints, shadow
  rules, detector modes) that `src/gateway/abuse.ts` loads at startup.
  `abuse-screen.ts` screens each request after authentication and records
  every match in `abuse_events`; `bun run abuse:check` tests a body locally.
  Optional: without it the gateway runs unscreened, and tests always use
  `src/test/abuse-rules.json`. Never add real rules to this repo; it is
  public.
- `src/lib/components/ui/**` — vendored shadcn-svelte. Do not edit.

## Hard rules

1. **Imports in SvelteKit code use `#lib/<path>.ts` with the extension.**
   `$lib` does not exist in this SvelteKit version. Code under
   `src/gateway|billing|providers|analytics|auth` uses relative imports.
2. **`src/env.ts` must keep `export const variables = {}`.** SvelteKit 3
   reserves that file. Configuration is read through `loadEnv()` in the same
   file; add new variables there and to `.env.example`.
3. **Money is `Usd` (`src/billing/money.ts`), never `number`.** Parse
   provider strings with `Usd.parse`; `Usd.fromNumber` only at a provider
   boundary that gives you a float. No arithmetic on floats.
4. **Every upstream provider call goes through `runMeteredRequest`**
   (`src/gateway/metered-request.ts`): reserve → dispatch → settle exactly
   once. Never call a paid provider outside it.
5. **API errors are `HttpError(status, message)`** and serialise as
   `{ "error": "<message>" }`. Messages are shown to callers; never put
   stack traces or upstream secrets in them.
6. **Never log or persist credentials.** Headers reach analytics only
   through the allow-list in `redactHeaders` (`metered-request.ts`); add a
   header there only if a dashboard needs it, never a credential-bearing
   one.
7. **Schema changes are new numbered files** in `migrations/<store>/`,
   applied by dbmate (`scripts/migrate.ts`): each file needs `-- migrate:up`
   and `-- migrate:down` markers. Never edit an applied migration. A
   ClickHouse file holds exactly one idempotent statement, and neither
   migrations nor queries qualify tables with a database (`request_events`,
   not `hcai.request_events`): the database is `CLICKHOUSE_DB`, and tests
   run against their own.
8. **Billing invariants** in `docs/architecture/storage-and-billing.md`
   are not negotiable: one reservation per request, settle at most once,
   idempotent operations, PostgreSQL transaction time decides windows.

## Testing conventions

Rules for writing tests:

- **Never write unit tests after you write code.** A test written to fit
  code that already exists repeats what the code does and catches nothing.
- **Prefer E2E tests as the sole testing mechanism.** Use them to verify
  that complex features work: drive the real HTTP route with a real key,
  and let the request go through reserve → dispatch → settle. End each
  E2E test with a verifiable, repeatable artifact, meaning the data the
  flow recorded (billing rows from `billingRecords()`, the
  `request_events` row, the stored blob). Asserting on the response
  status alone is not enough.
- **If you must test a system in isolation, first write down every way it
  could fail, then write the code.** Each isolated test must correspond to
  one of those failure modes, use realistic inputs, and catch a bug the
  E2E suites would miss (money arithmetic edges, split or aborted
  streams, settle-at-most-once races). Never assert on constants or
  lookup tables, on type shapes, or on anything that restates the
  implementation.

Tests sit next to sources as `*.test.ts`; `*.integration.test.ts` names
suites that exercise a whole flow, and both always run. Use `bun:test`.
Tests use the real billing engine and real datastores, never a fake of our
own modules (`docs/adr/0001`): call `testDatabase()` / `testClickHouse()`
from `src/test/database.ts` at the top level of the file, and assert on
what was recorded with `billingRecords()` from
`src/gateway/routes/test-harness.ts`. Only external providers are faked
(`fakeFetch`); to inject a failure the database cannot produce, override
one operation with `withFaults()`.
