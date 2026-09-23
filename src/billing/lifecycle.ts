import { InvalidReservationStateError } from "./errors";

/**
 * The reservation state machine.
 *
 *   reserve ──▶ reserved ──finalize──▶ finalized
 *                  │  ▲
 *                  │  └───────────── (retrying reserve returns the live hold)
 *                  ├──markPending──▶ pending_reconciliation ──finalize──▶ finalized
 *                  │                        │
 *                  └──release──▶ released ◀─┘ release
 *                                   │
 *                                   └──markPending / finalize (late charge)
 *
 * `finalized` is terminal. `released` holds no money but is not terminal:
 * the expiry sweeper can release a request that is still streaming, and the
 * provider still charges for it, so a released reservation may yet be
 * marked pending or finalized. That late finalize is funded from whatever
 * the account has available at the time.
 */
export type ReservationState =
  | "reserved"
  | "pending_reconciliation"
  | "finalized"
  | "released";

export type Operation =
  | "reserve"
  | "finalize"
  | "release"
  | "markPendingReconciliation";

/**
 * What each operation does to a reservation in a given state:
 * - `apply`: perform the transition.
 * - `replay`: the operation already happened; return the reservation
 *   unchanged (the caller checks the retry matches the original).
 * - absent: refuse with InvalidReservationStateError.
 *
 * `reserve` never applies to an existing row (a new row is created only
 * when none exists). It replays only against a live hold, because a
 * released or settled reservation holds no funds and dispatching against
 * it would run the provider call unbilled.
 */
const RULES: Record<
  Operation,
  Partial<Record<ReservationState, "apply" | "replay">>
> = {
  reserve: { reserved: "replay" },
  finalize: {
    reserved: "apply",
    pending_reconciliation: "apply",
    released: "apply",
    finalized: "replay",
  },
  release: {
    reserved: "apply",
    pending_reconciliation: "apply",
    released: "replay",
  },
  markPendingReconciliation: {
    reserved: "apply",
    pending_reconciliation: "apply",
    released: "apply",
  },
};

const OPERATION_NAMES: Record<Operation, string> = {
  reserve: "reserve",
  finalize: "finalize",
  release: "release",
  markPendingReconciliation: "mark pending reconciliation",
};

/** Looks up `operation` for a reservation in `state`, or throws. */
export function transition(
  requestId: string,
  operation: Operation,
  state: ReservationState,
): "apply" | "replay" {
  const rule = RULES[operation][state];
  if (!rule) {
    throw new InvalidReservationStateError(
      requestId,
      state,
      OPERATION_NAMES[operation],
    );
  }
  return rule;
}
