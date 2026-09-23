# How the billing engine works

The policy rules and invariants live in
[`docs/architecture/storage-and-billing.md`](../../docs/architecture/storage-and-billing.md).
This page explains how the code carries them out.

## The model in one paragraph

An account has **counters**: funding windows (a recurring allowance, one
row per period), credit grants (one-off credit), and limit windows (a
spending cap, one row per period). Each counter has `reserved_usd` and
`committed_usd`. A reservation touches a counter only through a **hold**
row with the same two columns, one hold table per counter kind. **A
counter always equals the sum of its holds.** Every engine operation is
therefore a list of hold changes (`before → after`), and the counter
moves by the same difference. `audit.ts` checks that this still holds.

```
billing_funding_windows ◀── billing_reservation_funding_holds ──┐
billing_credit_grants   ◀── billing_reservation_credit_holds  ──┼── billing_reservations
billing_limit_windows   ◀── billing_reservation_limit_holds   ──┘         │
                                                                          ├── billing_ledger_entries (usage debit)
                                                                          └── request_event_outbox (analytics)
```

Funding counters supply money. Limit counters only constrain it: a
request is refused when any limit window's `limit − reserved − committed`
is below the estimate. Once charged, the full cost counts even past the
limit (`overage_usd`).

## One request, start to finish

Take an account with a $0.10 daily allowance and a $0.20 credit grant.
A request is estimated at $0.25, and the provider charges $0.40.

| Step | Allowance (reserved/committed) | Credit | Reservation |
|---|---|---|---|
| start | 0 / 0 | 0 / 0 | — |
| `reserve($0.25)` | 0.10 / 0 | 0.15 / 0 | `reserved` |
| `finalize($0.40)` | 0 / 0.10 | 0 / 0.20 | `finalized`, `unfunded_cost_usd = 0.10` |

Finalize commits each hold up to what it reserved ($0.10 + $0.15). It
then looks for the $0.15 above the estimate in what is still available,
and finds only the last $0.05 of credit. The remaining $0.10 is recorded
as unfunded. The charge is never clamped. This exact case is an integration
test.

## Lifecycle

`lifecycle.ts` holds the whole state machine as one table. Each operation
in each state is `apply`, `replay` (an idempotent retry: return the row
unchanged), or rejected.

| | reserved | pending_reconciliation | finalized | released |
|---|---|---|---|---|
| reserve (retry) | replay | ✗ | ✗ | ✗ |
| finalize | apply | apply | replay (same cost only) | apply (late charge) |
| release | apply | apply | ✗ | replay |
| markPendingReconciliation | apply | apply | ✗ | apply |

`released` is not terminal. The expiry sweeper can release a request that
is still streaming, and the provider still charges for it. That late
finalize has no holds, so it is funded from whatever is available at the
time and counted against the limit windows in force at the time.

## Every operation has the same four steps

`engine.ts` does no arithmetic of its own:

1. **Lock**: advisory-lock the account (`locks.ts`). Every window,
   expiry and timestamp uses SQL `now()`, the transaction's own clock. It
   is never passed in from JavaScript, whose `Date` would drop the
   microseconds.
2. **Read**: lock the needed rows in one pipelined round trip, then
   convert them to `Usd` planner inputs (`locks.ts`, `windows.ts`
   materializes the current period's windows first).
3. **Plan**: `transition()` decides whether the operation applies.
   `planReserve` / `planFinalize` (`plan.ts`) decide where every dollar
   goes, and throw if their own result does not add up.
4. **Write**: `writeHoldChange` / `releaseAllHolds` (`holds.ts`) turn the
   plan into SQL in one pipelined round trip. Finalize writes the ledger
   entry and outbox event in the same transaction.

## Files

| File | What it is | Needs a database to test? |
|---|---|---|
| `money.ts` | `Usd`, exact to 12 decimal places, bigint inside | no |
| `lifecycle.ts` | the state machine table | no |
| `plan.ts` | all money arithmetic: allocation order, reserve and finalize plans | no |
| `locks.ts` | locking reads, row → planner-input conversion | yes |
| `windows.ts` | creates the current funding and limit windows on demand | yes |
| `holds.ts` | writes hold changes; one writer for all three counter kinds | yes |
| `engine.ts` | `BillingEngine`: lock → read → plan → write | yes |
| `audit.ts` | `findBillingDrift`: read-only check that the books balance | yes |
| `reconciliation.ts` | cron: settles `pending_reconciliation` from provider records, releases expired holds | fakes / yes |
| `estimate-language-reservation.ts` | reservation estimate for chat/completions requests | no |

Only `engine.ts` (through `holds.ts`) writes counters, holds, the ledger,
or reservation state. The one exception is `reconciliation.ts`, which
bumps `billing_reservations.updated_at` to rotate its queue and changes
nothing else.

## Changing the engine safely

- Money logic belongs in `plan.ts`, with a unit test in `plan.test.ts`.
  If a change needs a new SQL shape, the model above is probably being
  bent. Revisit that first.
- A new state or transition is a row in `lifecycle.ts`, and the full-table
  test in `lifecycle.test.ts` will fail until you update it on purpose.
- Run `bun test` (it always includes `engine.integration.test.ts`). It calls
  `findBillingDrift` after every scenario, so a write that desynchronises
  a counter from its holds fails the scenario that caused it.
