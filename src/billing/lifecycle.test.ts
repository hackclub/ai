import { describe, expect, test } from "bun:test";

import { InvalidReservationStateError } from "./errors";
import { type Operation, type ReservationState, transition } from "./lifecycle";

const states: ReservationState[] = [
  "reserved",
  "pending_reconciliation",
  "finalized",
  "released",
];

const outcome = (operation: Operation, state: ReservationState) => {
  try {
    return transition("request", operation, state);
  } catch (error) {
    if (error instanceof InvalidReservationStateError) return "reject";
    throw error;
  }
};

describe("reservation lifecycle", () => {
  // The whole table, so any change to the state machine shows up here.
  test.each([
    ["reserve", ["replay", "reject", "reject", "reject"]],
    ["finalize", ["apply", "apply", "replay", "apply"]],
    ["release", ["apply", "apply", "reject", "replay"]],
    ["markPendingReconciliation", ["apply", "apply", "reject", "apply"]],
  ] as const)("%s from each state", (operation, expected) => {
    expect(states.map((state) => outcome(operation, state))).toEqual([...expected]);
  });

  test("finalized is terminal", () => {
    for (const operation of ["reserve", "release", "markPendingReconciliation"] as const) {
      expect(outcome(operation, "finalized")).toBe("reject");
    }
  });

  test("the error names the operation and state", () => {
    expect(() => transition("r1", "markPendingReconciliation", "finalized")).toThrow(
      "Cannot mark pending reconciliation reservation r1 while it is finalized",
    );
  });
});
