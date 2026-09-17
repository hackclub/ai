export class BillingError extends Error {}

export class BillingAccountNotFoundError extends BillingError {
  constructor(accountId: string) {
    super(`Billing account ${accountId} was not found`);
  }
}

export class ReservationNotFoundError extends BillingError {
  constructor(requestId: string) {
    super(`No billing reservation exists for request ${requestId}`);
  }
}

export class ReservationConflictError extends BillingError {
  constructor(requestId: string, detail: string) {
    super(`Reservation ${requestId} conflicts with the existing request: ${detail}`);
  }
}

export class InsufficientFundsError extends BillingError {
  constructor() {
    super("The billing account does not have enough available funding");
  }
}

export class LimitExceededError extends BillingError {
  constructor(policyName: string) {
    super(`The request would exceed the "${policyName}" spending limit`);
  }
}

export class InvalidReservationStateError extends BillingError {
  constructor(requestId: string, state: string, operation: string) {
    super(`Cannot ${operation} reservation ${requestId} while it is ${state}`);
  }
}
