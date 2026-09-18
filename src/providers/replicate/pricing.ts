import { Usd } from "../../billing/money";

/**
 * Replicate has no pricing API, but every model page embeds the same
 * `billingConfig` JSON its price popover renders from. Official models carry
 * per-unit prices keyed by the metric names that predictions later report in
 * `metrics`; community models carry the hardware's per-second rate and bill
 * on `metrics.predict_time`.
 */

export type ReplicateUnitPrice = {
  /** Prediction metric this price applies to, e.g. `character_input_count`. */
  metric: string;
  /** Human label, e.g. "input character". */
  display: string;
  /** Price for one unit of the metric. */
  unitUsd: Usd;
  /** The page's own label, e.g. "per thousand input characters". */
  title: string;
};

export type ReplicateTierCriterion =
  | { type: "equals"; title: string; value: string }
  | { type: "range"; title: string; min: number | null; max: number | null };

export type ReplicatePricingTier = {
  title: string | null;
  criteria: ReplicateTierCriterion[];
  prices: ReplicateUnitPrice[];
};

export type ReplicatePricing =
  | {
      kind: "per-unit";
      tiers: ReplicatePricingTier[];
      hardware: string;
      medianRunUsd: Usd | null;
    }
  | {
      kind: "hardware";
      hardware: string;
      perSecondUsd: Usd;
      medianRunUsd: Usd | null;
    };

export type ReplicatePredictionMetrics = Record<string, unknown>;

const ATOM_PRECISION = 1_000_000_000n;

/** Multiplies a price by a possibly fractional unit count without floats leaking into atoms. */
export const scaleUsd = (price: Usd, units: number): Usd => {
  if (!Number.isFinite(units) || units <= 0) return Usd.zero;
  const scaled = BigInt(Math.round(units * Number(ATOM_PRECISION)));
  return Usd.fromAtoms((price.toAtoms() * scaled) / ATOM_PRECISION);
};

const divideUsd = (price: Usd, divisor: bigint) => Usd.fromAtoms(price.toAtoms() / divisor);

const parseDollars = (value: string): Usd | null => {
  const match = /\$\s*([\d,]*\.?\d+)/.exec(value);
  if (!match?.[1]) return null;
  return Usd.parse(match[1].replaceAll(",", ""));
};

/** "per thousand output images" → 1000, "per million tokens" → 1e6, "per output" → 1. */
const unitsInTitle = (title: string): bigint => {
  const lower = title.toLowerCase();
  if (/\bper\s+thousand\b/.test(lower)) return 1_000n;
  if (/\bper\s+million\b/.test(lower)) return 1_000_000n;
  if (/\bper\s+hundred\b/.test(lower)) return 100n;
  const numeric = /\bper\s+([\d,]+)\b/.exec(lower);
  if (numeric?.[1]) return BigInt(numeric[1].replaceAll(",", ""));
  return 1n;
};

type RawPrice = {
  metric?: string;
  metric_display?: string;
  price?: string;
  title?: string;
  type?: string;
};
type RawCriterion = {
  type?: string;
  title?: string;
  value?: unknown;
};
type RawTier = { title?: string | null; criteria?: RawCriterion[]; prices?: RawPrice[] };
type RawProps = {
  hardware?: string;
  price?: string;
  p50price?: string;
  billingConfig?: { current_tiers?: RawTier[] } | null;
};

const parsePrice = (raw: RawPrice): ReplicateUnitPrice | null => {
  if (raw.type !== "per-unit" || !raw.metric || !raw.price) return null;
  const total = parseDollars(raw.price);
  if (!total) return null;
  const title = raw.title ?? "";
  return {
    metric: raw.metric,
    display: raw.metric_display ?? raw.metric,
    unitUsd: divideUsd(total, unitsInTitle(title)),
    title,
  };
};

const parseCriterion = (raw: RawCriterion): ReplicateTierCriterion | null => {
  const title = raw.title ?? "";
  if (raw.type === "equals" && typeof raw.value === "string") {
    return { type: "equals", title, value: raw.value };
  }
  if (raw.type === "range" && Array.isArray(raw.value)) {
    const [min, max] = raw.value as unknown[];
    return {
      type: "range",
      title,
      min: typeof min === "number" ? min : null,
      max: typeof max === "number" ? max : null,
    };
  }
  return null;
};

const PROPS_SCRIPT =
  /<script id="react-component-props-[^"]+" type="application\/json">([\s\S]*?)<\/script>/g;

/**
 * Extracts pricing from a Replicate model page. Returns null when the page has
 * no recognisable pricing block, which callers treat as "cannot bill".
 */
export const parseReplicatePricing = (html: string): ReplicatePricing | null => {
  for (const match of html.matchAll(PROPS_SCRIPT)) {
    const json = match[1] ?? "";
    if (!json.includes("billingConfig")) continue;
    let props: RawProps;
    try {
      props = JSON.parse(json) as RawProps;
    } catch {
      continue;
    }
    const hardware = props.hardware ?? "unknown";
    const medianRunUsd = props.p50price ? parseDollars(props.p50price) : null;

    const tiers = (props.billingConfig?.current_tiers ?? [])
      .map((tier): ReplicatePricingTier => ({
        title: tier.title ?? null,
        criteria: (tier.criteria ?? [])
          .map(parseCriterion)
          .filter((c): c is ReplicateTierCriterion => c !== null),
        prices: (tier.prices ?? [])
          .map(parsePrice)
          .filter((p): p is ReplicateUnitPrice => p !== null),
      }))
      .filter((tier) => tier.prices.length > 0);
    if (tiers.length > 0) return { kind: "per-unit", tiers, hardware, medianRunUsd };

    const perSecondUsd = props.price ? parseDollars(props.price) : null;
    if (perSecondUsd && /per second/i.test(props.price ?? "")) {
      return { kind: "hardware", hardware, perSecondUsd, medianRunUsd };
    }
  }
  return null;
};

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== "count");

/**
 * Tier criteria name metrics by display title ("output image pixel") rather
 * than key ("image_output_pixel_count"), so match on word overlap.
 */
const findMetricValue = (metrics: ReplicatePredictionMetrics, title: string): unknown => {
  const wanted = words(title);
  if (wanted.length === 0) return undefined;
  for (const [key, value] of Object.entries(metrics)) {
    const have = new Set(words(key));
    if (wanted.every((w) => have.has(w))) return value;
  }
  return undefined;
};

const criterionMatches = (
  criterion: ReplicateTierCriterion,
  metrics: ReplicatePredictionMetrics,
): boolean | null => {
  const value = findMetricValue(metrics, criterion.title);
  if (value === undefined) return null;
  if (criterion.type === "equals") return String(value) === criterion.value;
  if (typeof value !== "number") return null;
  // Replicate ranges are lower-exclusive and upper-inclusive ("> 1,024 and ≤ 4,096").
  if (criterion.min !== null && value <= criterion.min) return false;
  if (criterion.max !== null && value > criterion.max) return false;
  return true;
};

const tierCost = (tier: ReplicatePricingTier, units: (price: ReplicateUnitPrice) => number) =>
  tier.prices.reduce((sum, price) => sum.add(scaleUsd(price.unitUsd, units(price))), Usd.zero);

const maxBy = <T>(items: T[], score: (item: T) => bigint): T | undefined => {
  let best: T | undefined;
  let bestScore = -1n;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
};

const metricNumber = (metrics: ReplicatePredictionMetrics, key: string) => {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * The cost Replicate will charge for a finished prediction, from its
 * `metrics`. Picks the tier whose criteria the metrics satisfy; when the
 * metrics cannot decide, the most expensive tier is charged so the account is
 * never under-billed.
 */
export const predictionCost = (
  pricing: ReplicatePricing,
  metrics: ReplicatePredictionMetrics,
): Usd => {
  if (pricing.kind === "hardware") {
    return scaleUsd(pricing.perSecondUsd, metricNumber(metrics, "predict_time"));
  }
  const units = (price: ReplicateUnitPrice) => metricNumber(metrics, price.metric);
  const matching = pricing.tiers.filter((tier) =>
    tier.criteria.every((criterion) => criterionMatches(criterion, metrics) === true),
  );
  const candidates = matching.length > 0 ? matching : pricing.tiers;
  const chosen = maxBy(candidates, (tier) => tierCost(tier, units).toAtoms());
  return chosen ? tierCost(chosen, units) : Usd.zero;
};

const HARDWARE_HOLD_MULTIPLIER = 4n;
const DEFAULT_DURATION_SECONDS = 60;

const stringLength = (input: Record<string, unknown>) =>
  Object.values(input).reduce<number>(
    (sum, value) => sum + (typeof value === "string" ? value.length : 0),
    0,
  );

const positiveNumber = (input: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
};

/** Units a request will plausibly consume, for the pre-dispatch hold. */
const estimatedUnits = (price: ReplicateUnitPrice, input: Record<string, unknown>) => {
  const metric = price.metric;
  if (/input/.test(metric) && /(character|token)/.test(metric)) {
    return Math.max(1, stringLength(input));
  }
  if (/duration|seconds/.test(metric)) {
    return positiveNumber(input, ["duration", "duration_seconds", "length", "seconds"]) ??
      DEFAULT_DURATION_SECONDS;
  }
  if (/output_count|image_count/.test(metric)) {
    return positiveNumber(input, ["num_outputs", "num_images", "number_of_images", "n"]) ?? 1;
  }
  return 1;
};

/**
 * The amount to hold before dispatching. Deliberately generous: the hold is
 * released down to the real cost once the prediction's metrics arrive.
 */
export const estimatePredictionCost = (
  pricing: ReplicatePricing,
  input: Record<string, unknown>,
): Usd => {
  const median = pricing.medianRunUsd ?? Usd.zero;
  if (pricing.kind === "hardware") return median.multiply(HARDWARE_HOLD_MULTIPLIER);
  const chosen = maxBy(pricing.tiers, (tier) =>
    tierCost(tier, (price) => estimatedUnits(price, input)).toAtoms(),
  );
  const estimate = chosen ? tierCost(chosen, (price) => estimatedUnits(price, input)) : Usd.zero;
  return estimate.toAtoms() > median.toAtoms() ? estimate : median;
};

const trimUsd = (usd: Usd) => {
  const text = usd.toString().replace(/0+$/, "").replace(/\.$/, "");
  return text === "0" ? "$0" : `$${text}`;
};

/** One-line human summary for the dashboard, e.g. "$0.015 per thousand input characters". */
export const describePricing = (pricing: ReplicatePricing): string => {
  if (pricing.kind === "hardware") {
    const median = pricing.medianRunUsd ? `≈ ${trimUsd(pricing.medianRunUsd)} per run · ` : "";
    return `${median}${trimUsd(pricing.perSecondUsd)}/s on ${pricing.hardware}`;
  }
  const first = pricing.tiers[0]?.prices[0];
  if (!first) return "";
  const suffix = pricing.tiers.length > 1 ? ` (from, ${pricing.tiers.length} tiers)` : "";
  const total = scaleUsd(first.unitUsd, Number(unitsInTitle(first.title)));
  return `${trimUsd(total)} ${first.title}${suffix}`;
};

export type ReplicatePricingSourceOptions = {
  fetch?: typeof fetch;
  ttlMs?: number;
  siteUrl?: string;
};

export type ReplicatePricingSource = {
  /** Resolves pricing for an owner/name, or null when Replicate exposes none. */
  get(model: string): Promise<ReplicatePricing | null>;
};

/**
 * Caches page-scraped pricing per model with single-flight refreshes. A failed
 * refresh keeps serving the last good value so a Replicate site hiccup does
 * not take the proxy down; a model with no cached value and a failed fetch
 * resolves to null.
 */
export const createReplicatePricingSource = (
  options: ReplicatePricingSourceOptions = {},
): ReplicatePricingSource => {
  const fetchImplementation = options.fetch ?? fetch;
  const ttlMs = options.ttlMs ?? 60 * 60 * 1_000;
  const siteUrl = (options.siteUrl ?? "https://replicate.com").replace(/\/$/, "");
  const cache = new Map<string, { value: ReplicatePricing | null; fetchedAt: number }>();
  const inFlight = new Map<string, Promise<ReplicatePricing | null>>();

  const load = async (model: string) => {
    const response = await fetchImplementation(`${siteUrl}/${model}`, {
      headers: { accept: "text/html", "user-agent": "ReplicateProxy/1.0" },
    });
    if (!response.ok) throw new Error(`Replicate page for ${model} returned HTTP ${response.status}`);
    return parseReplicatePricing(await response.text());
  };

  return {
    async get(model) {
      const cached = cache.get(model);
      if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.value;
      const pending = inFlight.get(model);
      if (pending) return pending;
      const refresh = load(model)
        .then((value) => {
          cache.set(model, { value, fetchedAt: Date.now() });
          return value;
        })
        .catch((error: unknown) => {
          if (cached) return cached.value;
          throw error;
        })
        .finally(() => inFlight.delete(model));
      inFlight.set(model, refresh);
      return refresh;
    },
  };
};
