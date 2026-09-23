/** A non-negative safe integer from an untrusted provider field, or null. */
export const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
