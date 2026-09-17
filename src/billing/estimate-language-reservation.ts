import { Usd } from "./money";

export type LanguageReservationInput = {
  serializedBillableInput: string;
  inputTokenPriceUsd: string;
  outputTokenPriceUsd: string;
  requestedMaxOutputTokens?: number;
  modelMaxOutputTokens: number;
  fixedCostUsd?: string;
};

export type LanguageReservationEstimate = {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  amountUsd: Usd;
};

const assertTokenLimit = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
};

/**
 * Produces the upper-bound hold used before dispatching a language-model
 * request. This does not mutate the request: when the caller omits an output
 * limit, the model's declared maximum is reserved while the parameter remains
 * absent upstream.
 */
export function estimateLanguageReservation(
  input: LanguageReservationInput,
): LanguageReservationEstimate {
  assertTokenLimit("modelMaxOutputTokens", input.modelMaxOutputTokens);

  if (input.requestedMaxOutputTokens !== undefined) {
    assertTokenLimit(
      "requestedMaxOutputTokens",
      input.requestedMaxOutputTokens,
    );
  }

  const inputPrice = Usd.parse(input.inputTokenPriceUsd);
  const outputPrice = Usd.parse(input.outputTokenPriceUsd);
  const fixedCost = Usd.parse(input.fixedCostUsd ?? "0");

  if (
    inputPrice.isNegative() ||
    outputPrice.isNegative() ||
    fixedCost.isNegative()
  ) {
    throw new RangeError("Provider prices must not be negative");
  }

  // String.length counts UTF-16 code units. This intentionally overcounts
  // astral characters compared with a code-point count, which is preferable
  // for a conservative reservation.
  const estimatedInputTokens = Math.ceil(
    input.serializedBillableInput.length / 4,
  );
  const desiredOutputTokens =
    input.requestedMaxOutputTokens ?? input.modelMaxOutputTokens;
  const reservedOutputTokens = Math.min(
    desiredOutputTokens,
    input.modelMaxOutputTokens,
  );

  const amountUsd = inputPrice
    .multiply(BigInt(estimatedInputTokens))
    .add(outputPrice.multiply(BigInt(reservedOutputTokens)))
    .add(fixedCost);

  return {
    estimatedInputTokens,
    reservedOutputTokens,
    amountUsd,
  };
}
