import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";

import { migrateJobQueue } from "../../analytics/worker";
import { createUser, issueApiKey } from "../../auth/users";
import { BillingEngine } from "../../billing/engine";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { Usd } from "../../billing/money";
import type { ReplicatePricing } from "../../providers/replicate/pricing";
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
  const upstream: Array<{
    url: string;
    method: string;
    body: unknown;
    form: FormData | null;
    headers: Headers;
    signal: AbortSignal | null | undefined;
  }> = [];
  let nextStatus = 201;
  let predictionCounter = 0;
  const pricing: ReplicatePricing = {
    kind: "hardware",
    hardware: "T4",
    perSecondUsd: Usd.parse("0.0002"),
    medianRunUsd: Usd.parse("0.001"),
  };

  const fakeFetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    upstream.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      form: init?.body instanceof FormData ? init.body : null,
      headers: new Headers(init?.headers),
      signal: init?.signal,
    });
    if (url.endsWith("/v1/files") && method === "POST") {
      return Response.json({ id: "file1", urls: { get: "https://api.replicate.com/v1/files/file1" } }, { status: 201 });
    }
    if (/\/v1\/files\/[^/]+$/.test(url)) return Response.json({ id: url.split("/").at(-1) });
    // Lookups report the prediction finished with 2.5s of hardware time.
    const lookup = /\/v1\/predictions\/([a-z0-9]+)(\/cancel)?$/.exec(url);
    if (lookup) {
      return Response.json({
        id: lookup[1],
        status: lookup[2] ? "canceled" : "succeeded",
        metrics: { predict_time: 2.5 },
        urls: {
          get: `https://api.replicate.com/v1/predictions/${lookup[1]}`,
          cancel: `https://api.replicate.com/v1/predictions/${lookup[1]}/cancel`,
        },
      });
    }
    // The create call returns a still-running prediction.
    predictionCounter += 1;
    const id = `pred${predictionCounter}`;
    return Response.json(
      {
        id,
        status: "starting",
        urls: {
          get: `https://api.replicate.com/v1/predictions/${id}`,
          cancel: `https://api.replicate.com/v1/predictions/${id}/cancel`,
          stream: "https://stream.replicate.com/v1/files/abc",
        },
      },
      { status: nextStatus },
    );
  }) as typeof fetch;

  const app = () => {
    if (!sql) throw new Error("Missing database");
    return replicateRoutes({
      sql,
      billing: new BillingEngine(sql),
      replicateApiKey: "replicate-secret",
      enforceIdv: false,
      fetch: fakeFetch,
      pricing: { get: async () => pricing },
      settlementTimeoutMs: 5_000,
      publicBaseUrl: "https://gateway.test",
    });
  };

  const call = (path: string, init: RequestInit = {}) =>
    app().handle(
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
      DELETE FROM request_event_outbox
      WHERE payload->>'account_id' = ${accountId}
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

  const latestReservation = async (wantState = "finalized") => {
    if (!sql) throw new Error("Missing database");
    let row: { state: string; actual_cost_usd: string } | undefined;
    for (let attempt = 0; attempt < 200 && row?.state !== wantState; attempt += 1) {
      [row] = await sql<{ state: string; actual_cost_usd: string }[]>`
        SELECT state, actual_cost_usd::text FROM billing_reservations
        WHERE account_id = ${accountId}::uuid AND provider = 'replicate'
        ORDER BY created_at DESC LIMIT 1
      `;
      if (row?.state !== wantState) await Bun.sleep(20);
    }
    return row;
  };

  integrationTest("rejects unlisted models before any upstream call", async () => {
    const before = upstream.length;
    const response = await call("/models/evil/model/predictions", {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(403);
    expect(upstream.length).toBe(before);
  });

  integrationTest("builds model paths from the allowlisted id, not the raw params", async () => {
    // Elysia decodes %2F, so a `..` segment in the model param used to reach
    // /v1/predictions (every user's predictions) with the shared token.
    const response = await call(`/models/${owner}/${name}:%2F..%2F..%2F..%2Fpredictions`, {
      method: "GET",
    });
    expect(response.status).not.toBe(403);
    await response.text();
    expect(upstream.at(-1)?.url).toBe(`https://api.replicate.com/v1/models/${knownModel}`);

    const version = await call(`/models/${owner}/${name}/versions/..%2F..%2F..%2Fpredictions`, {
      method: "GET",
    });
    expect(version.status).toBe(400);
  });

  integrationTest("dispatches predictions without the client's abort signal", async () => {
    const controller = new AbortController();
    const response = await call(`/models/${owner}/${name}/predictions`, {
      method: "POST",
      body: JSON.stringify({ input: { a: 1 } }),
      signal: controller.signal,
    });
    expect(response.status).toBe(201);
    await response.text();
    expect(upstream.at(-1)?.signal).toBeUndefined();
    await latestReservation();
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

  integrationTest("creates a versioned prediction and bills the reported hardware time", async () => {
    nextStatus = 201;
    const response = await call(`/models/${owner}/${name}:${knownVersion}/predictions`, {
      method: "POST",
      headers: { prefer: "wait" },
      body: JSON.stringify({ input: { text: "hi" }, model: "ignored" }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; status: string; urls: Record<string, string> };
    expect(created.status).toBe("starting");
    // API links now point at the gateway; the signed stream link is untouched.
    expect(created.urls.get).toBe(`https://gateway.test/proxy/v1/replicate/predictions/${created.id}`);
    expect(created.urls.cancel).toBe(
      `https://gateway.test/proxy/v1/replicate/predictions/${created.id}/cancel`,
    );
    expect(created.urls.stream).toBe("https://stream.replicate.com/v1/files/abc");

    const sent = upstream.find((c) => c.url === "https://api.replicate.com/v1/predictions" && c.method === "POST");
    expect(sent?.body).toEqual({ input: { text: "hi" }, version: `${knownModel}:${knownVersion}` });
    expect(sent?.headers.get("authorization")).toBe("Bearer replicate-secret");
    expect(sent?.headers.get("prefer")).toBe("wait");

    // 2.5 seconds at $0.0002/s.
    const row = await latestReservation();
    expect(row?.state).toBe("finalized");
    expect(row?.actual_cost_usd).toBe(Usd.parse("0.0005").toString());
    expect(upstream.some((c) => c.url.endsWith(`/v1/predictions/${created.id}`))).toBeTrue();
  });

  integrationTest("decides access from 'version' alone on the bare predictions route", async () => {
    const before = upstream.length;
    // An allowlisted model in the body cannot smuggle in another model's version.
    const smuggled = await call("/predictions", {
      method: "POST",
      body: JSON.stringify({ model: knownModel, version: "black-forest-labs/flux-1.1-pro", input: {} }),
    });
    expect(smuggled.status).toBe(403);
    const unknownVersion = await call("/predictions", {
      method: "POST",
      body: JSON.stringify({ model: knownModel, version: "a".repeat(64), input: {} }),
    });
    expect(unknownVersion.status).toBe(403);
    expect(upstream.length).toBe(before);

    // A bare version id is canonicalised; the 'model' field never reaches Replicate.
    const ok = await call("/predictions", {
      method: "POST",
      body: JSON.stringify({ model: knownModel, version: knownVersion, input: { a: 1 } }),
    });
    expect(ok.status).toBe(201);
    await ok.text();
    expect(upstream.at(-1)?.body).toEqual({ input: { a: 1 }, version: `${knownModel}:${knownVersion}` });

    // 'model' alone goes to the official-model endpoint, which has no version field.
    const official = await call("/predictions", {
      method: "POST",
      body: JSON.stringify({ model: knownModel, input: { b: 2 } }),
    });
    expect(official.status).toBe(201);
    await official.text();
    expect(upstream.at(-1)?.url).toBe(`https://api.replicate.com/v1/models/${knownModel}/predictions`);
    expect(upstream.at(-1)?.body).toEqual({ input: { b: 2 } });
    await latestReservation();
  });

  integrationTest("scopes prediction reads and cancels to their creator", async () => {
    if (!sql) throw new Error("Missing database");
    const created = await call("/predictions", {
      method: "POST",
      body: JSON.stringify({ version: knownVersion, input: {} }),
    });
    const { id } = (await created.json()) as { id: string };

    const mine = await call(`/predictions/${id}`, { method: "GET" });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { urls: { get: string } }).urls.get).toBe(
      `https://gateway.test/proxy/v1/replicate/predictions/${id}`,
    );
    const cancelled = await call(`/predictions/${id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);

    const stranger = await createUser(sql, { slackId: `U-stranger-${runId}`, dailyAllowanceUsd: "1" });
    const strangerKey = (await issueApiKey(sql, stranger.userId, "stranger")).key;
    const before = upstream.length;
    const theirs = await call(`/predictions/${id}`, {
      method: "GET",
      headers: { authorization: `Bearer ${strangerKey}` },
    });
    expect(theirs.status).toBe(404);
    const theirCancel = await call(`/predictions/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${strangerKey}` },
    });
    expect(theirCancel.status).toBe(404);
    expect(upstream.length).toBe(before);
    await sql`DELETE FROM users WHERE id = ${stranger.userId}::uuid`;
    await latestReservation();
  });

  integrationTest("does not expose account-wide listings", async () => {
    const before = upstream.length;
    for (const path of ["/predictions", "/files", "/deployments"]) {
      const response = await call(path, { method: "GET" });
      expect(response.status).toBe(404);
    }
    expect(upstream.length).toBe(before);
  });

  integrationTest("forwards SDK-style file uploads with their metadata and scopes the file", async () => {
    if (!sql) throw new Error("Missing database");
    const form = new FormData();
    form.append("content", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    form.append("metadata", new Blob([JSON.stringify({ a: 1 })], { type: "application/json" }));
    const response = await app().handle(
      new Request("http://gateway.test/proxy/v1/replicate/files", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      }),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { urls: { get: string } }).urls.get).toBe(
      "https://gateway.test/proxy/v1/replicate/files/file1",
    );
    const sent = upstream.at(-1)?.form;
    expect((sent?.get("content") as File).name).toBe("hello.txt");
    expect(await (sent?.get("metadata") as Blob).text()).toBe(JSON.stringify({ a: 1 }));

    expect((await call("/files/file1", { method: "GET" })).status).toBe(200);
    expect((await call("/files/nope", { method: "GET" })).status).toBe(404);
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
    const row = await latestReservation();
    expect(row?.actual_cost_usd).toBe("0.000000000000");
    nextStatus = 201;
  });

  integrationTest("validates prediction ids before touching the database", async () => {
    const bad = await call("/predictions/NOT-VALID", { method: "GET" });
    expect(bad.status).toBe(400);
  });
});
