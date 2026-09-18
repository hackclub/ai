# Hack Club AI gateway — agent notes

Read this before changing anything. `README.md` covers setup;
`docs/architecture/storage-and-billing.md` covers the billing invariants;
`plans/README.md` lists pending improvement plans.

## Stack (pre-releases are load-bearing)

Bun 1.4 · Elysia 2.0 pre-release (exact pin in `package.json`) · SvelteKit 3
`next` + `@sveltejs/adapter-bun` `next` · Svelte 5 runes · Tailwind v4 ·
TypeScript 6 · PostgreSQL 18 (`postgres` driver) · ClickHouse 26.2
(`@clickhouse/client`) · Graphile Worker.

Never run `bun update`, never change a framework version as a side effect of
another change, and always install with `bun install --frozen-lockfile`.
Elysia exp builds break between versions; bumping one is its own PR.

## Commands

| Task | Command |
|---|---|
| Dev server (dashboard + API, HMR) | `bun run dev` → http://localhost:3000 |
| Standalone API only | `bun run api` |
| Typecheck (the baseline gate) | `bun run typecheck` |
| Svelte check | `bun run check` |
| Unit tests | `bun test` |
| Production build / run | `bun run build` then `bun run start` |
| Local databases | `bun run db:up` / `db:down` / `db:logs` / `db:check` |
| Wipe local databases | `bun run db:reset` (destructive) |
| Apply migrations (once plan 002 lands) | `bun run db:migrate` |
| Seed a dev user, key, and session | `bun run dev:seed` |

Verification baseline for any change: `bun run typecheck` exits 0 and
`bun test` reports `0 fail`. Integration tests are skipped unless
`BILLING_TEST_DATABASE_URL` (and for ClickHouse delivery
`ANALYTICS_TEST_DATABASE_URL` + `ANALYTICS_TEST_CLICKHOUSE_URL`) point at a
running database. Stop `bun run dev` before running them: its in-process
outbox drainer deletes rows the tests count. Prefer a dedicated test
database over the dev one.

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
- `src/billing/` — `engine.ts` is the only writer of `billing_*` tables.
  `money.ts` is the money type. `reconciliation.ts` settles uncertain
  reservations on a cron.
- `src/providers/` — upstream adapters (OpenRouter, Replicate, JSON providers).
- `src/analytics/` — outbox → ClickHouse drainer and dashboard queries.
- `src/auth/` — API keys, sessions, Hack Club OAuth.
- `src/routes/` + `src/lib/` — SvelteKit pages and shared UI/server code.
- `migrations/postgres`, `migrations/clickhouse` — numbered SQL files.
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
6. **Never log or persist credentials.** `SENSITIVE_HEADERS` in
   `metered-request.ts` is stripped before headers reach analytics; keep it
   in sync when a provider adds a credential header.
7. **Schema changes are new numbered files** in `migrations/<store>/`.
   Never edit an applied migration. ClickHouse DDL must be idempotent.
8. **Billing invariants** in `docs/architecture/storage-and-billing.md`
   are not negotiable: one reservation per request, settle at most once,
   idempotent operations, PostgreSQL transaction time decides windows.

## Testing conventions

Tests sit next to sources as `*.test.ts` (unit, always run) and
`*.integration.test.ts` (gated as above). Use `bun:test`. Structural
fakes are preferred over mocks; see `src/gateway/metered-request.test.ts`
for an in-memory `BillingLifecycle`.
