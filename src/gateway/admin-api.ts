import { Elysia } from "elysia";

import { AdminUserError, type AdminUsers } from "../admin/users";
import type { ServedBy } from "../analytics/queries";
import { type Sessions, sessionAccess } from "../auth/sessions";
import { BANNED_MESSAGE } from "../auth/users";
import { type DiscountBook, DiscountError, type DiscountInput } from "../billing/discounts";
import { Usd } from "../billing/money";
import { type GlobalPolicies, type PolicyChange, PolicyError, type PolicyKind } from "../billing/policies";
import { HttpError } from "./http-error";
import { assertSameOrigin } from "./origin-check";

export type AdminApiOptions = {
  /** Public origin of this deployment; mutations must come from it. */
  baseUrl: string;
  sessions: Sessions;
  users: AdminUsers;
  policies: GlobalPolicies;
  discounts: DiscountBook;
  /** Upstreams that served requests recently; a discount may only name one of these. */
  servedBy: () => Promise<ServedBy[]>;
};

type Body = Record<string, unknown>;

const readBody = async (request: Request): Promise<Body> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body as Body;
};

const string = (body: Body, key: string): string => {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value.trim();
};

const optionalString = (body: Body, key: string): string | null => {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value.trim() || null;
};

const boolean = (body: Body, key: string): boolean => {
  const value = body[key];
  if (typeof value !== "boolean") throw new HttpError(400, `${key} must be true or false`);
  return value;
};

const usd = (body: Body, key: string): Usd => {
  try {
    return Usd.parse(string(body, key));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `${key} must be a dollar amount`);
  }
};

const optionalDate = (body: Body, key: string): Date | null => {
  const value = optionalString(body, key);
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${key} must be a date`);
  return date;
};

const kind = (value: string): PolicyKind => {
  if (value !== "funding" && value !== "limit") throw new HttpError(404, "Not found");
  return value;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = (value: string) => {
  if (!UUID.test(value)) throw new HttpError(404, "Not found");
  return value;
};

/** The admin's own mistakes are 400s with the reason; anything else is a 500. */
const asHttp = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PolicyError || error instanceof DiscountError || error instanceof AdminUserError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
};

/**
 * Session-authenticated admin API behind the `/admin` pages. Every route
 * requires a signed-in, unbanned admin and a same-origin request, and every
 * change is recorded in `admin_audit_events`.
 */
export const adminApiRoutes = (options: AdminApiOptions) => {
  const discountInput = async (body: Body, current: string | null): Promise<DiscountInput> => {
    const servedBy = optionalString(body, "servedBy");
    if (servedBy !== null && servedBy !== current) {
      const seen = await options.servedBy();
      if (!seen.some((upstream) => upstream.servedBy === servedBy)) {
        throw new HttpError(400, `No request has been served by ${servedBy} in the last 30 days`);
      }
    }
    return {
      modelPattern: optionalString(body, "modelPattern"),
      servedBy,
      percentOff: string(body, "percentOff"),
      note: optionalString(body, "note"),
      enabled: boolean(body, "enabled"),
      endsAt: optionalDate(body, "endsAt"),
    };
  };

  return new Elysia({ prefix: "/api/admin" })
    .derive(async ({ request }) => {
      assertSameOrigin(request, options.baseUrl);
      const access = sessionAccess(await options.sessions.user(request.headers.get("cookie")));
      if (!access.ok) {
        throw access.reason === "banned"
          ? new HttpError(403, BANNED_MESSAGE)
          : new HttpError(401, "Authentication required");
      }
      if (!access.user.isAdmin) throw new HttpError(403, "Admins only");
      return { admin: access.user };
    })
    .post("/users/:id/ban", async ({ params, request, admin }) => {
      const body = await readBody(request);
      await asHttp(() =>
        options.users.setBanned(admin.id, uuid(params.id), boolean(body, "banned"), optionalString(body, "reason")),
      );
      return { success: true };
    })
    .post("/policies/:kind", async ({ params, request, admin }) => {
      const body = await readBody(request);
      const id = await asHttp(() =>
        options.policies.create(admin.id, kind(params.kind), {
          name: string(body, "name"),
          cadence: string(body, "cadence"),
          amountUsd: usd(body, "amountUsd"),
          priority: typeof body.priority === "number" ? body.priority : undefined,
          enabled: boolean(body, "enabled"),
          effectiveUntil: optionalDate(body, "effectiveUntil"),
        }),
      );
      return { id };
    })
    .patch("/policies/:kind/:id", async ({ params, request, admin }) => {
      const body = await readBody(request);
      const change: PolicyChange = {};
      if (body.name !== undefined) change.name = string(body, "name");
      if (body.amountUsd !== undefined) change.amountUsd = usd(body, "amountUsd");
      if (body.priority !== undefined) {
        if (typeof body.priority !== "number") throw new HttpError(400, "priority must be a number");
        change.priority = body.priority;
      }
      if (body.enabled !== undefined) change.enabled = boolean(body, "enabled");
      if (body.effectiveUntil !== undefined) change.effectiveUntil = optionalDate(body, "effectiveUntil");
      await asHttp(() => options.policies.update(admin.id, kind(params.kind), uuid(params.id), change));
      return { success: true };
    })
    .delete("/policies/:kind/:id", async ({ params, admin }) => ({
      outcome: await asHttp(() => options.policies.remove(admin.id, kind(params.kind), uuid(params.id))),
    }))
    .post("/discounts", async ({ request, admin }) => {
      const input = await discountInput(await readBody(request), null);
      return { id: await asHttp(() => options.discounts.create(admin.id, input)) };
    })
    .put("/discounts/:id", async ({ params, request, admin }) => {
      const id = uuid(params.id);
      const current = (await options.discounts.list()).find((discount) => discount.id === id);
      if (!current) throw new HttpError(404, "Discount not found");
      const input = await discountInput(await readBody(request), current.servedBy);
      await asHttp(() => options.discounts.update(admin.id, id, input));
      return { success: true };
    })
    .delete("/discounts/:id", async ({ params, admin }) => {
      await asHttp(() => options.discounts.remove(admin.id, uuid(params.id)));
      return { success: true };
    });
};
