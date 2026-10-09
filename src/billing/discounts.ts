import type postgres from "postgres";

import { recordAdminAction } from "../admin/audit";
import type { Tables } from "../db-types";
import type { Usd } from "./money";
import { applyDiscount } from "./plan";

type Sql = postgres.Sql;

export type Discount = {
  id: string;
  /** An exact model id, or a prefix ending in `*` ("anthropic/*"). */
  modelPattern: string | null;
  /** The upstream that must have served the request ("Anthropic"); null for any. */
  servedBy: string | null;
  percentOff: string;
  note: string | null;
  enabled: boolean;
  startsAt: Date;
  endsAt: Date | null;
};

export type DiscountInput = {
  modelPattern: string | null;
  servedBy: string | null;
  percentOff: string;
  note: string | null;
  enabled: boolean;
  endsAt: Date | null;
};

export type AppliedDiscount = { discount: Discount; billedUsd: Usd };

export class DiscountError extends Error {}

type DiscountRow = Pick<
  Tables["pricing_discounts"],
  "id" | "model_pattern" | "served_by" | "note" | "enabled" | "starts_at" | "ends_at"
> & { percent_off: string };

const toDiscount = (row: DiscountRow): Discount => ({
  id: row.id,
  modelPattern: row.model_pattern,
  servedBy: row.served_by,
  percentOff: row.percent_off,
  note: row.note,
  enabled: row.enabled,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
});

const modelMatches = (pattern: string, model: string) => {
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  // "anthropic/claude-x" also covers its routing variants ("…:nitro").
  return model === pattern || model.split(":")[0] === pattern;
};

/**
 * The model a discount is checked against: the one that ran when the
 * provider reports it. A request that fell back to another model, even the
 * same vendor's, is not discounted as the requested one; a caller can force
 * that fallback.
 */
const ranModelMatches = (pattern: string, request: { model: string; ranModel: string | null }) =>
  modelMatches(pattern, request.ranModel ?? request.model);

const inEffect = (discount: Discount, now: Date) =>
  discount.enabled && discount.startsAt <= now && (discount.endsAt === null || discount.endsAt > now);

const percent = (discount: Discount) => Number(discount.percentOff);

/** The largest discount among those that match; discounts do not stack. */
const best = (discounts: Discount[]) =>
  discounts.reduce<Discount | null>((top, next) => (top === null || percent(next) > percent(top) ? next : top), null);

const PERCENT = /^(\d{1,3})(\.\d{1,2})?$/;

const validate = (input: DiscountInput) => {
  if (!input.modelPattern && !input.servedBy) {
    throw new DiscountError("A discount needs a model, an upstream provider, or both");
  }
  if (input.modelPattern !== null && (input.modelPattern.length > 200 || /\s/.test(input.modelPattern))) {
    throw new DiscountError("The model must be a model id or a prefix ending in *");
  }
  if (input.modelPattern?.includes("*") && !/^[^*]+\*$/.test(input.modelPattern)) {
    throw new DiscountError("Only a trailing * is supported, as in anthropic/*");
  }
  const match = PERCENT.exec(input.percentOff);
  const value = Number(input.percentOff);
  if (!match || !(value > 0) || value > 100) throw new DiscountError("Percent off must be above 0 and at most 100");
  if (input.note !== null && input.note.length > 500) throw new DiscountError("The note is too long");
  if (input.endsAt && input.endsAt <= new Date()) throw new DiscountError("The end must be in the future");
};

/**
 * Pricing discounts, cached briefly: every billed request consults them.
 * Admin changes made through this instance apply at once; another process
 * picks them up within `ttlMs`.
 */
export class DiscountBook {
  private cache: { at: number; discounts: Promise<Discount[]> } | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly ttlMs = 15_000,
  ) {}

  private current(): Promise<Discount[]> {
    if (!this.cache || Date.now() - this.cache.at > this.ttlMs) {
      const discounts = this.list().then((all) => all.filter((discount) => discount.enabled));
      // A failed load is not cached; the next request retries it.
      discounts.catch(() => {
        if (this.cache?.discounts === discounts) this.cache = null;
      });
      this.cache = { at: Date.now(), discounts };
    }
    return this.cache.discounts;
  }

  async list(): Promise<Discount[]> {
    const rows = await this.sql<DiscountRow[]>`
      SELECT id, model_pattern, served_by, percent_off::text AS percent_off, note, enabled, starts_at, ends_at
      FROM pricing_discounts
      ORDER BY enabled DESC, created_at DESC
    `;
    return rows.map(toDiscount);
  }

  /** Discounts in effect for a model, whichever upstream serves it; for the models pages. */
  async forModel(model: string, now = new Date()): Promise<Discount[]> {
    return (await this.current()).filter(
      (discount) => inEffect(discount, now) && (discount.modelPattern === null || modelMatches(discount.modelPattern, model)),
    );
  }

  /**
   * The discount on a request's cost. One naming an upstream applies only
   * when that upstream served the request; a request whose upstream is
   * unknown gets only discounts that name none. The model is the one that
   * ran, so a fallback is not discounted as the requested model.
   */
  async charge(
    cost: Usd,
    request: { model: string; ranModel: string | null; servedBy: string | null },
    now = new Date(),
  ): Promise<AppliedDiscount | null> {
    const discount = best(
      (await this.current()).filter(
        (candidate) =>
          inEffect(candidate, now) &&
          (candidate.servedBy === null || candidate.servedBy === request.servedBy) &&
          (candidate.modelPattern === null || ranModelMatches(candidate.modelPattern, request)),
      ),
    );
    return discount ? { discount, billedUsd: applyDiscount(cost, discount.percentOff) } : null;
  }

  async create(actorUserId: string, input: DiscountInput): Promise<string> {
    validate(input);
    const id = await this.sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO pricing_discounts (model_pattern, served_by, percent_off, note, enabled, ends_at)
        VALUES (${input.modelPattern}, ${input.servedBy}, ${input.percentOff}::numeric, ${input.note}, ${input.enabled}, ${input.endsAt})
        RETURNING id
      `;
      if (!row) throw new Error("PostgreSQL did not return the new discount");
      await recordAdminAction(tx, { actorUserId, action: "discount_created", targetType: "discount", targetId: row.id, details: input });
      return row.id;
    });
    this.cache = null;
    return id;
  }

  async update(actorUserId: string, id: string, input: DiscountInput): Promise<void> {
    validate(input);
    await this.sql.begin(async (tx) => {
      const [before] = await tx<DiscountRow[]>`
        SELECT id, model_pattern, served_by, percent_off::text AS percent_off, note, enabled, starts_at, ends_at
        FROM pricing_discounts WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (!before) throw new DiscountError("Discount not found");
      await tx`
        UPDATE pricing_discounts
        SET model_pattern = ${input.modelPattern}, served_by = ${input.servedBy}, percent_off = ${input.percentOff}::numeric,
          note = ${input.note}, enabled = ${input.enabled}, ends_at = ${input.endsAt}, updated_at = now()
        WHERE id = ${id}::uuid
      `;
      await recordAdminAction(tx, {
        actorUserId,
        action: "discount_changed",
        targetType: "discount",
        targetId: id,
        details: { ...input, before: toDiscount(before) },
      });
    });
    this.cache = null;
  }

  /** Billed requests keep the discount's id and percentage in their analytics event. */
  async remove(actorUserId: string, id: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [before] = await tx<DiscountRow[]>`
        DELETE FROM pricing_discounts WHERE id = ${id}::uuid
        RETURNING id, model_pattern, served_by, percent_off::text AS percent_off, note, enabled, starts_at, ends_at
      `;
      if (!before) throw new DiscountError("Discount not found");
      await recordAdminAction(tx, {
        actorUserId,
        action: "discount_deleted",
        targetType: "discount",
        targetId: id,
        details: { before: toDiscount(before) },
      });
    });
    this.cache = null;
  }
}

/** The discounts billing consults; absent, everything is billed at cost. */
export type Discounts = Pick<DiscountBook, "charge">;

/**
 * What to bill for `cost`, and the analytics attributes that explain it. A
 * discount that cannot be read bills the full cost rather than leave the
 * request unsettled.
 */
export const priced = async (
  discounts: Discounts | undefined,
  cost: Usd,
  log: { error: (fields: object, message: string) => void },
  request: { requestId: string; provider: string; model: string; ranModel: string | null; servedBy: string | null },
): Promise<{ billed: Usd; attributes: Record<string, string> }> => {
  const attributes: Record<string, string> = request.servedBy ? { served_by: request.servedBy } : {};
  // Discounts price the OpenRouter catalog the models pages list. Other
  // providers' ids can share its owner/name shape (Replicate's do).
  if (!discounts || request.provider !== "openrouter") return { billed: cost, attributes };
  try {
    const applied = await discounts.charge(cost, request);
    if (!applied) return { billed: cost, attributes };
    return {
      billed: applied.billedUsd,
      attributes: { ...attributes, discount_id: applied.discount.id, discount_percent_off: applied.discount.percentOff },
    };
  } catch (error) {
    log.error({ err: error, requestId: request.requestId }, "discount lookup failed; billing the full cost");
    return { billed: cost, attributes };
  }
};
