import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../../analytics/worker";
import { createUser, issueApiKey } from "../../auth/users";
import { BillingEngine } from "../../billing/engine";
import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { replicateModelCosts } from "../../config/replicate-models";
import { createFeatureFlags } from "../../features";
import { replicateRoutes } from "./replicate";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const runId = crypto.randomUUID().slice(0, 8);

const knownVersion = Object.keys(allowedReplicateModelVersions)[0] ?? "";
const knownModel = allowedReplicateModelVersions[knownVersion] ?? "";
const [owner, name] = knownModel.split("/") as [string, string];

describe("Replicate routes with PostgreSQL", () => {
  let sql: Sql | undefined;
  let userId: string;
  let accountId: string;
  let apiKey: string;
  const upstream: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  let nextStatus = 201;

  const fakeFetch = (async (input, init) => {
    const url = String(input);
    upstream.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      headers: new Headers(init?.headers),
    });
    return Response.json({ id: "pred1", status: "starting" }, { status: nextStatus });
  }) as typeof fetch;

  const app = (flags: string[] = ["enable_replicate"]) => {
    if (!sql) throw new Error("Missing database");
    return replicateRoutes({
      sql,
      billing: new BillingEngine(sql),
      features: createFeatureFlags({ alwaysEnabled: flags }),
      replicateApiKey: "replicate-secret",
      enforceIdv: false,
      fetch: fakeFetch,
    });
  };

  const call = (path: string, init: RequestInit = {}, flags?: string[]) =>
    app(flags).handle(
      new Request(`http://gateway.test/proxy/v1/replicate${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 4 });
    await migrateJobQueue(databaseUrl);
    const user = await createUser(sql, { slackId: `U-replicate-${runId}`, dailyAllowanceUsd: "1" });
    userId = user.userId;
    accountId = user.billingAccountId;
    apiKey = (await issueApiKey(sql, userId, "replicate")).key;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`
      SELECT graphile_worker.complete_jobs(ARRAY(
        SELECT id FROM graphile_worker._private_jobs
        WHERE payload->>'account_id' = ${accountId}
      ))
    `;
    const reservations = sql`
      SELECT id FROM billing_reservations WHERE account_id = ${accountId}::uuid
    `;
    await sql`DELETE FROM billing_ledger_entries WHERE account_id = ${accountId}::uuid`;
    for (const table of [
      "billing_reservation_funding_holds",
      "billing_reservation_credit_holds",
      "billing_reservation_limit_holds",
    ]) {
      await sql`DELETE FROM ${sql(table)} WHERE reservation_id IN (${reservations})`;
    }
    await sql`DELETE FROM billing_reservations WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_windows WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_funding_policies WHERE account_id = ${accountId}::uuid`;
    await sql`DELETE FROM billing_accounts WHERE id = ${accountId}::uuid`;
    await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
    await sql.end();
  });

  integrationTest("requires the feature flag", async () => {
    const flagged = await call("/predictions", { method: "GET" }, []);
    expect(flagged.status).toBe(403);
    expect(await flagged.json()).toEqual({
      error: "Replicate access is not enabled for your account",
    });
  });

  integrationTest("rejects unlisted models before any upstream call", async () => {
    const before = upstream.length;
    const response = await call("/models/evil/model/predictions", {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(403);
    expect(upstream.length).toBe(before);
  });

  integrationTest("rejects conflicting versions in path and body", async () => {
    const response = await call(`/models/${owner}/${name}:${knownVersion}/predictions`, {
      method: "POST",
      body: JSON.stringify({ input: {}, version: "someother" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Conflicting version specified in path and request body.",
    });
  });

  integrationTest("creates a versioned prediction and bills the fixed cost", async () => {
    if (!sql) throw new Error("Missing database");
    nextStatus = 201;
    const response = await call(`/models/${owner}/${name}:${knownVersion}/predictions`, {
      method: "POST",
      headers: { prefer: "wait" },
      body: JSON.stringify({ input: { text: "hi" }, model: "ignored" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "pred1", status: "starting" });

    const sent = upstream.at(-1);
    expect(sent?.url).toBe("https://api.replicate.com/v1/predictions");
    expect(sent?.body).toEqual({ input: { text: "hi" }, version: `${knownModel}:${knownVersion}` });
    expect(sent?.headers.get("authorization")).toBe("Bearer replicate-secret");
    expect(sent?.headers.get("prefer")).toBe("wait");

    const expected = Usd.parse(replicateModelCosts.get(knownModel) ?? "0").toString();
    let row: { state: string; actual_cost_usd: string } | undefined;
    for (let attempt = 0; attempt < 50 && row?.state !== "finalized"; attempt += 1) {
      [row] = await sql<{ state: string; actual_cost_usd: string }[]>`
        SELECT state, actual_cost_usd::text FROM billing_reservations
        WHERE account_id = ${accountId}::uuid AND provider = 'replicate'
        ORDER BY created_at DESC LIMIT 1
      `;
      if (row?.state !== "finalized") await Bun.sleep(20);
    }
    expect(row?.state).toBe("finalized");
    expect(row?.actual_cost_usd).toBe(expected);
  });

  integrationTest("finalizes a provider error at zero cost", async () => {
    if (!sql) throw new Error("Missing database");
    nextStatus = 422;
    const response = await call("/predictions", {
      method: "POST",
      body: JSON.stringify({ version: knownVersion, input: {} }),
    });
    expect(response.status).toBe(422);
    await response.text();
    let row: { state: string; actual_cost_usd: string } | undefined;
    for (let attempt = 0; attempt < 50 && row?.state !== "finalized"; attempt += 1) {
      [row] = await sql<{ state: string; actual_cost_usd: string }[]>`
        SELECT state, actual_cost_usd::text FROM billing_reservations
        WHERE account_id = ${accountId}::uuid AND provider = 'replicate'
        ORDER BY created_at DESC LIMIT 1
      `;
      if (row?.state !== "finalized") await Bun.sleep(20);
    }
    expect(row?.actual_cost_usd).toBe("0.000000000000");
    nextStatus = 201;
  });

  integrationTest("forwards read-only routes with cursors and validates ids", async () => {
    const list = await call("/predictions?cursor=abc", { method: "GET" });
    expect(list.status).toBe(201);
    expect(upstream.at(-1)?.url).toBe("https://api.replicate.com/v1/predictions?cursor=abc");
    const bad = await call("/predictions/NOT-VALID", { method: "GET" });
    expect(bad.status).toBe(400);
  });
});
