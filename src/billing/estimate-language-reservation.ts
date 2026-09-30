import { Usd } from "./money";

export type LanguageReservationInput = {
  serializedBillableInput: string;
  /** Image inputs, whose payload is left out of `serializedBillableInput`. */
  images?: number;
  /** Prompt tokens held for each image. */
  tokensPerImage?: number;
  inputTokenPriceUsd: string;
  outputTokenPriceUsd: string;
  requestedMaxOutputTokens?: number;
  modelMaxOutputTokens: number;
  /** Completions generated per request (OpenAI `n`); each has its own output. */
  completions?: number;
  fixedCostUsd?: string;
  /** Prices that replace the base ones once the prompt reaches `minPromptTokens`. */
  tiers?: Array<{ minPromptTokens: number; inputTokenPriceUsd: string; outputTokenPriceUsd: string }>;
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
  const completions = input.completions ?? 1;
  if (!Number.isSafeInteger(completions) || completions < 1) {
    throw new RangeError("completions must be a positive safe integer");
  }

  if (input.requestedMaxOutputTokens !== undefined) {
    assertTokenLimit(
      "requestedMaxOutputTokens",
      input.requestedMaxOutputTokens,
    );
  }

  // String.length counts UTF-16 code units. This intentionally overcounts
  // astral characters compared with a code-point count, which is preferable
  // for a conservative reservation.
  const estimatedInputTokens =
    Math.ceil(input.serializedBillableInput.length / 4) +
    (input.images ?? 0) * (input.tokensPerImage ?? 0);
  assertTokenLimit("estimatedInputTokens", estimatedInputTokens);

  // The highest tier the prompt reaches prices the whole request.
  const tier = (input.tiers ?? [])
    .filter((candidate) => estimatedInputTokens >= candidate.minPromptTokens)
    .sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
  const inputPrice = Usd.parse(tier?.inputTokenPriceUsd ?? input.inputTokenPriceUsd);
  const outputPrice = Usd.parse(tier?.outputTokenPriceUsd ?? input.outputTokenPriceUsd);
  const fixedCost = Usd.parse(input.fixedCostUsd ?? "0");

  if (
    inputPrice.isNegative() ||
    outputPrice.isNegative() ||
    fixedCost.isNegative()
  ) {
    throw new RangeError("Provider prices must not be negative");
  }

  const desiredOutputTokens =
    input.requestedMaxOutputTokens ?? input.modelMaxOutputTokens;
  // The prompt is billed once; every completion can use the full output.
  const reservedOutputTokens =
    Math.min(desiredOutputTokens, input.modelMaxOutputTokens) * completions;

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
