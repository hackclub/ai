# Storage and billing architecture

## Status

Accepted. The reservation transactions are implemented and covered by the
integration suite; production sizing remains to be validated.

## Data ownership

- PostgreSQL is the source of truth for accounts, funding, limits,
  reservations, charges, credits, and adjustments.
- ClickHouse is the primary store for request analytics and complete searchable
  request and response bodies.
- ClickHouse keeps request and response bodies for 90 days (column TTL);
  event dimensions (ids, model, tokens, cost, headers, attributes) are
  retained indefinitely. Changing that is a policy decision, not a bug.
- Billing enforcement never queries ClickHouse.
- Finalized usage reaches ClickHouse through the `request_event_outbox`
  table, written in the finalization transaction. The analytics worker
  drains it in batches: it claims rows with a time-boxed lease (stamping
  `claimed_at`, so no Postgres transaction stays open across the ClickHouse
  round trip), inserts into ClickHouse, then deletes the delivered rows. A
  crash between insert and delete lets the claim expire and the batch is
  redelivered, which ClickHouse's ReplacingMergeTree collapses by event ID,
  so delivery is at least once. Rows that exhaust their attempts stay for
  inspection, but their request and response bodies are stripped after 7
  days. The outbox deliberately avoids NOTIFY: PostgreSQL serializes the
  commit of every notifying transaction through one lock held across the WAL
  flush, which capped finalizations at roughly 200 per second when each one
  enqueued a Graphile Worker job.
- Authorization and provider credentials must be removed from headers before
  an event enters the job payload.

## Billing concepts

How the engine implements these (the counter/hold model, the lifecycle
table, a worked example) is in [`src/billing/README.md`](../../src/billing/README.md).

The engine does not have a built-in daily limit.

- A **funding policy** creates recurring spendable windows, such as a daily or
  monthly allowance.
- A **credit grant** creates non-recurring spendable credit, optionally with an
  expiration.
- A **limit policy** constrains total spend over a period without itself
  supplying funds. Several limits may apply simultaneously.
- A **reservation** temporarily allocates funding and holds capacity in every
  applicable limit window before an upstream request is sent.
- A **ledger entry** is an immutable debit or credit. Mutable bucket counters
  are enforcement projections that can be checked and rebuilt against the
  ledger.
- A **manual reset** increments a policy generation and supersedes its current
  window. It never deletes or rewrites historical usage.

## Required billing invariants

1. Every accepted upstream request has one durable reservation.
2. A reservation is finalized or released at most once.
3. Funding allocation, limit holds, and reservation creation are one
   PostgreSQL transaction.
4. Finalization, ledger insertion, counter updates, and analytics job
   enqueueing are one PostgreSQL transaction.
5. Reservation and finalization operations are idempotent.
6. Analytics delivery failure cannot change billing results.
7. Money uses exact decimal arithmetic and never JavaScript floating point.
8. Unknown provider outcomes remain pending until reconciled or explicitly
   resolved.
9. Manual changes are append-only, attributed, and auditable.
10. PostgreSQL transaction time determines active policy windows and
    reservation expiry. Application-host clock skew cannot change which
    funding or limit window applies.

Final provider cost may exceed its reservation despite conservative
estimation. Finalization still records the complete debit. Any amount that
cannot be allocated to a funding source is recorded as `unfunded_cost_usd`,
and every applicable limit window exposes its generated `overage_usd`. Neither
condition is hidden by clamping the charge.

## Initial reservation estimates

Language-model reservations use a deliberately simple upper-bound estimate:

```text
estimated input tokens = ceil(serialized billable input characters / 4)
estimated output tokens = caller maximum, when present
                        = model/provider maximum otherwise
                        × n (completions requested, 1 to 8; 400 above 8)

reservation =
    estimated input tokens × input token price
  + estimated output tokens × output token price
  + fixed provider charges
```

OpenRouter does not inject a default for an omitted sampling parameter. It
omits the parameter upstream and lets the selected provider apply its own
default. The gateway must preserve that behavior: it does not add
`max_tokens`, `max_completion_tokens`, or `max_output_tokens` when the caller
omits them.

For a hard budget guarantee, the reservation uses the model/provider's
declared maximum output when no limit is present. This can be conservative, but
it does not alter generation behavior. If provider metadata does not expose a
usable maximum, the adapter must either reject the request under hard-limit
enforcement or use an explicitly configured fallback that permits a documented
overage risk; it must not silently mutate the request.

Provider adapters for images, OCR, search, and asynchronous predictions supply
their own estimators.

The reservation is not a charge. Finalization replaces its hold with
provider-reported or reconciled actual usage. For OpenRouter, interrupted or
otherwise uncertain generations can be reconciled through its generation
metadata endpoint using the generation ID.

References:

- [OpenRouter API parameters](https://openrouter.ai/docs/api_reference/parameters)
- [OpenRouter generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)

## Request lifecycle

`runMeteredRequest` in `src/gateway/metered-request.ts` is the only path an
upstream call takes through billing:

1. Reserve the estimate. An insufficient-funds or limit error is raised before
   any provider traffic.
2. Dispatch through the provider adapter. A transport failure releases the
   reservation and rethrows.
3. Stream the provider response to the caller byte-for-byte. The adapter
   observes the same bytes to derive usage and captures the complete body.
4. When the caller finishes reading or cancels, settle exactly once:
   - Provider-reported usage: finalize with the actual cost and emit the
     analytics event, including redacted headers and both bodies.
   - Provider HTTP error (non-2xx): finalize at zero cost so the failed request
     is still recorded, with `outcome = provider_error`.
   - Successful status without authoritative usage (client cancellation,
     truncated stream, missing usage block): mark the reservation pending
     reconciliation. The hold stays in place until reconciled.

Credential headers (`authorization`, `proxy-authorization`, `cookie`,
`set-cookie`, `x-api-key`) are dropped before headers enter the job payload.

## Search model

`hcai.request_events` stores complete request and response bodies in compressed
`String` columns with separate ClickHouse text indexes. A normal phrase search
uses `hasAllTokens` to narrow candidate rows and verifies exact adjacency with
`positionCaseInsensitiveUTF8`.

Literal substring and punctuation-sensitive searches may scan more data. We
will only add an n-gram index if measured query volume justifies its additional
storage.

Columnar storage keeps routine dashboards from reading body columns when they
only select dimensions, token counts, latency, and cost.

## Reconciliation

A reservation can end in `pending_reconciliation` (client cancelled,
stream truncated, provider returned no usage) or stay `reserved` forever if
the process died mid-request. The `billing.reconcile` Graphile Worker task
runs every five minutes (`src/billing/reconciliation.ts`):

1. Reservations still `reserved` past `expires_at` are released.
2. Each pending reservation with a provider request ID is looked up by
   provider:

   | Provider | Lookup | Outcome |
   |---|---|---|
   | `openrouter` | generation metadata endpoint by generation id | finalized with recorded cost, `usage_source = reconciled`, analytics `outcome = reconciled` (no bodies) |
   | `replicate` | prediction by id, billed from terminal metrics and live model pricing | finalized; a running prediction or one without billable metrics is `not_ready` and stays pending (no 24 h release) |
   | anything else | none | released after 24 hours without a ledger entry |

3. A pending reservation with no provider record after 24 hours is released;
   younger ones are retried on the next run.

A row the provider knows about but cannot yet be billed (`not_ready`) is
kept pending and moved to the back of the queue; its 24-hour expiry is
measured from `created_at`.

Every row is settled through the engine's own transactions, so concurrent
runs and retries are safe, and one failing row never blocks the batch.
