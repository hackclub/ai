import { describe, expect, test } from "bun:test";

import { AnalyticsQueries } from "../analytics/queries";
import { toClickHouseEvent } from "../analytics/request-event";
import { issueApiKey, revokeOwnedApiKey } from "../auth/api-keys";
import { createSessions, type SessionUser } from "../auth/sessions";
import { createUser } from "../auth/users";
import type { JsonValue } from "../billing/engine";
import { BillingEngine } from "../billing/engine";
import { Usd } from "../billing/money";
import { ModelCatalog } from "../models/catalog";
import { createReplicateCatalog } from "../providers/replicate/catalog";
import { testClickHouse, testDatabase } from "../test/database";
import { type DashboardEnv, DashboardReadModel, parseActivityCursor } from "./read-model";

const { sql } = await testDatabase();
const { clickhouse } = await testClickHouse();

const env: DashboardEnv = {
  nodeEnv: "test",
  baseUrl: "http://gateway.test",
  enforceIdv: false,
  featuredModels: ["x/y", "z"],
  mistralOcrPagePriceUsd: "0.001",
  typesafeInputPricePerMillionUsd: "0.042",
};

// OpenRouter is external, so its listings are served by a fake fetch.
const longDescription = "A".repeat(230) + " see [docs](https://example.com/docs) for more " + "B".repeat(100);
const languageListing = [
  { id: "openai/gpt-x", name: "GPT X", description: longDescription, architecture: { modality: "text->text" } },
  { id: "acme/unnamed", name: "", architecture: { modality: "text->text" } },
  { id: "img/pix", name: "Pix", architecture: { modality: "text->image", output_modalities: ["image"] } },
  { id: "emb/in-language", name: "Emb In Language", architecture: { modality: "text->embeddings" } },
];
const embeddingListing = [{ id: "emb/endpoint", name: "Emb Endpoint" }];

const openRouterFetch = (status = 200) =>
  (async (input: string | URL | Request) => {
    if (status !== 200) return new Response("unavailable", { status });
    const url = String(input);
    if (url === "https://openrouter.test/v1/models") return Response.json({ data: languageListing });
    if (url === "https://openrouter.test/v1/embeddings/models") return Response.json({ data: embeddingListing });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

const replicateFetch = (async (input: string | URL | Request) => {
  if (String(input) === "https://replicate.test/v1/models/minimax/speech-02-turbo") {
    return Response.json({ owner: "minimax", name: "speech-02-turbo", url: "", description: "TTS", visibility: "public" });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** A real read model over the test datastores; AnalyticsQueries is rebuilt per call since it memoizes. */
const readModel = (options: { env?: DashboardEnv; catalogStatus?: number } = {}) =>
  new DashboardReadModel({
    sql,
    analytics: new AnalyticsQueries(clickhouse),
    catalog: new ModelCatalog({
      baseUrl: "https://openrouter.test",
      apiKey: "k",
      fetch: openRouterFetch(options.catalogStatus),
    }),
    replicateCatalog: createReplicateCatalog({
      apiKey: "k",
      baseUrl: "https://replicate.test",
      pricing: { get: async () => null },
      fetch: replicateFetch,
    }),
    env: options.env ?? env,
  });

const sessions = createSessions({ sql, secureCookies: false });
let users = 0;
const signedIn = async (): Promise<SessionUser> => {
  const created = await createUser(sql, { slackId: `U-read-model-${++users}` });
  const user = await sessions.user((await sessions.start(created.userId)).split(";")[0] ?? null);
  if (!user) throw new Error("the new session did not resolve");
  return user;
};

let second = 0;
/** A production-shaped request_events row. */
const event = (accountId: string, fields: Record<string, JsonValue> = {}) =>
  toClickHouseEvent({
    event_id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    account_id: accountId,
    occurred_at: new Date(Date.UTC(2026, 8, 20, 12, 0, 0) + ++second * 1_000).toISOString(),
    model: "openai/gpt-x",
    outcome: "completed",
    input_tokens: 10,
    output_tokens: 5,
    billed_cost_usd: "0.001",
    ...fields,
  });
const insertEvents = async (values: ReturnType<typeof event>[]) => {
  // Each test sees only its own events, so global aggregates are exact.
  await clickhouse.command({ query: "TRUNCATE TABLE request_events" });
  await clickhouse.insert({ table: "request_events", values, format: "JSONEachRow" });
};

describe("site", () => {
  test("falls back to the default featured model", () => {
    expect(readModel({ env: { ...env, featuredModels: [] } }).site.featuredModel).toBe("openai/gpt-4o-mini");
    expect(readModel().site.featuredModel).toBe("x/y");
  });

  test("devMode follows NODE_ENV", () => {
    expect(readModel({ env: { ...env, nodeEnv: "development" } }).site.devMode).toBeTrue();
    expect(readModel({ env: { ...env, nodeEnv: "production" } }).site.devMode).toBeFalse();
  });

  test("carries the page facts", () => {
    expect(readModel().site).toEqual({
      baseUrl: "http://gateway.test",
      devMode: false,
      enforceIdv: false,
      featuredModels: ["x/y", "z"],
      featuredModel: "x/y",
      ocrPagePriceUsd: "0.001",
      jevInputPricePerMillionUsd: "0.042",
    });
  });
});

describe("spending", () => {
  test("a fresh user shows the policy allowance and nothing spent", async () => {
    const user = await signedIn();
    expect(await readModel().spending(user)).toEqual({ spentUsd: "0", limitUsd: "3.000000000000" });
  });

  test("a reservation counts as spent against the window's grant", async () => {
    const user = await signedIn();
    await new BillingEngine(sql).reserve({
      requestId: crypto.randomUUID(),
      accountId: user.billingAccountId,
      userId: user.id,
      apiKeyId: null,
      endpoint: "chat/completions",
      provider: "openrouter",
      estimatedCostUsd: Usd.parse("0.25"),
    });
    expect(await readModel().spending(user)).toEqual({ spentUsd: "0.250000000000", limitUsd: "3.000000000000" });
  });

  test("a window that granted nothing falls back to the policy amount", async () => {
    const user = await signedIn();
    // A zero-cost reserve materializes today's window without holding anything in it.
    await new BillingEngine(sql).reserve({
      requestId: crypto.randomUUID(),
      accountId: user.billingAccountId,
      userId: user.id,
      apiKeyId: null,
      endpoint: "chat/completions",
      provider: "openrouter",
      estimatedCostUsd: Usd.zero,
    });
    const windows = await sql`
      UPDATE billing_funding_windows SET granted_usd = 0 WHERE account_id = ${user.billingAccountId}::uuid
    `;
    expect(windows.count).toBe(1);
    await sql`UPDATE billing_funding_policies SET amount_usd = 5 WHERE account_id = ${user.billingAccountId}::uuid`;
    expect(await readModel().spending(user)).toEqual({ spentUsd: "0.000000000000", limitUsd: "5.000000000000" });
  });

  test("no policy and no window is zero of zero", async () => {
    const user = await signedIn();
    await sql`DELETE FROM billing_funding_policies WHERE account_id = ${user.billingAccountId}::uuid`;
    expect(await readModel().spending(user)).toEqual({ spentUsd: "0", limitUsd: "0" });
  });
});

describe("keys", () => {
  test("lists only the user's active keys, newest first, masked", async () => {
    const user = await signedIn();
    const other = await signedIn();
    const first = await issueApiKey(sql, user.id, "first");
    const revoked = await issueApiKey(sql, user.id, "revoked");
    const newest = await issueApiKey(sql, user.id, "newest");
    await issueApiKey(sql, other.id, "not mine");
    expect(await revokeOwnedApiKey(sql, user.id, revoked.id)).toBeTrue();

    const keys = await readModel().keys(user);
    expect(keys.map((key) => key.id)).toEqual([newest.id, first.id]);
    expect(keys[0]).toEqual({
      id: newest.id,
      name: "newest",
      keyPreview: `${newest.keyPrefix}••••••••`,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      lastUsedAt: null,
    });
  });
});

describe("activity", () => {
  test("enriches rows with key names, model names and error labels", async () => {
    const user = await signedIn();
    const other = await signedIn();
    const active = await issueApiKey(sql, user.id, "Active key");
    const revoked = await issueApiKey(sql, user.id, "Gone key");
    await revokeOwnedApiKey(sql, user.id, revoked.id);

    const oldest = event(user.billingAccountId, { api_key_id: active.id, attributes: { ip: "203.0.113.7" } });
    const unnamed = event(user.billingAccountId, {
      api_key_id: revoked.id,
      model: "acme/unnamed",
      outcome: "upstream_error",
    });
    const unlisted = event(user.billingAccountId, { model: "nobody/unlisted", outcome: "failed", error_code: "rate_limited" });
    const embedding = event(user.billingAccountId, { api_key_id: active.id, model: "emb/endpoint" });
    const othersRow = event(other.billingAccountId);
    await insertEvents([oldest, unnamed, unlisted, embedding, othersRow]);

    const page = await readModel().activity(user);
    expect(page.next).toBeNull();
    expect(page.rows.map((row) => row.requestId)).toEqual([
      embedding.request_id,
      unlisted.request_id,
      unnamed.request_id,
      oldest.request_id,
    ]);
    const [embeddingRow, unlistedRow, unnamedRow, oldestRow] = page.rows;

    expect(oldestRow).toEqual({
      requestId: oldest.request_id,
      occurredAt: expect.any(String),
      model: "openai/gpt-x",
      modelName: "GPT X",
      inputTokens: 10,
      outputTokens: 5,
      billedCostUsd: "0.001",
      durationMs: 0,
      error: null,
      apiKeyName: "Active key",
      ip: "203.0.113.7",
    });
    expect(new Date(oldestRow?.occurredAt ?? "").getTime()).toBe(Date.parse(`${oldest.occurred_at.replace(" ", "T")}Z`));
    expect(unnamedRow).toMatchObject({ modelName: "acme/unnamed", apiKeyName: "revoked key", error: "upstream error", ip: "" });
    expect(unlistedRow).toMatchObject({ modelName: "nobody/unlisted", apiKeyName: "revoked key", error: "rate_limited" });
    expect(embeddingRow).toMatchObject({ modelName: "Emb Endpoint", apiKeyName: "Active key", error: null });
  });

  test("renders model ids when the catalog listing fails", async () => {
    const user = await signedIn();
    await insertEvents([event(user.billingAccountId)]);
    const page = await readModel({ catalogStatus: 500 }).activity(user);
    expect(page.rows.map((row) => row.modelName)).toEqual(["openai/gpt-x"]);
  });

  test("pages 50 rows at a time through the cursor", async () => {
    const user = await signedIn();
    const events = Array.from({ length: 51 }, () => event(user.billingAccountId));
    await insertEvents(events);
    const model = readModel();

    const first = await model.activity(user);
    expect(first.rows).toHaveLength(50);
    expect(first.next).not.toBeNull();

    // The page sends the cursor back as query parameters.
    const cursor = parseActivityCursor(new URLSearchParams(first.next ?? {}));
    expect(cursor).not.toBeNull();
    const rest = await model.activity(user, cursor ?? undefined);
    expect(rest.rows.map((row) => row.requestId)).toEqual([events[0]?.request_id]);
    expect(rest.next).toBeNull();
  });
});

describe("parseActivityCursor", () => {
  const beforeId = "0b7c2f7e-8f55-4f0c-9d8c-6a7c1d2e3f40";

  test.each([
    ["a missing before", `beforeId=${beforeId}`],
    ["a missing beforeId", "before=2026-09-19T00:00:00Z"],
    ["an unparseable date", `before=yesterday&beforeId=${beforeId}`],
    ["a non-UUID beforeId", "before=2026-09-19T00:00:00Z&beforeId=not-a-uuid"],
  ])("is null for %s", (_label, query) => {
    expect(parseActivityCursor(new URLSearchParams(query))).toBeNull();
  });

  test("normalizes the date to ISO 8601", () => {
    expect(parseActivityCursor(new URLSearchParams(`before=2026-09-19T00:00:00Z&beforeId=${beforeId}`))).toEqual({
      before: "2026-09-19T00:00:00.000Z",
      beforeId,
    });
  });
});

describe("usage", () => {
  test("totals the user's requests and the global and per-model stats", async () => {
    const user = await signedIn();
    const other = await signedIn();
    await insertEvents([
      event(user.billingAccountId, { input_tokens: 10, output_tokens: 5 }),
      event(user.billingAccountId, { input_tokens: 20, output_tokens: 7 }),
      event(other.billingAccountId, { model: "zero/model", input_tokens: 0, output_tokens: 0, billed_cost_usd: "0" }),
    ]);

    expect(await readModel().usage(user)).toEqual({
      totalRequests: 2,
      totalTokens: 42,
      totalPromptTokens: 30,
      totalCompletionTokens: 12,
    });
    expect(await readModel().globalUsage()).toEqual({
      globalStats: { totalRequests: 3, totalTokens: 42, totalPromptTokens: 30, totalCompletionTokens: 12 },
      modelStats: [
        { model: "openai/gpt-x", totalRequests: 2, totalTokens: 42, totalPromptTokens: 30, totalCompletionTokens: 12 },
      ],
    });
  });
});

describe("models", () => {
  test("groups the listings into language, image and embedding cards", async () => {
    const cards = await readModel().modelCards();
    expect(cards.languageModels.map((card) => card.id)).toEqual(["openai/gpt-x", "acme/unnamed"]);
    expect(cards.imageModels.map((card) => card.id)).toEqual(["img/pix"]);
    expect(cards.embeddingModels.map((card) => card.id)).toEqual(["emb/endpoint", "emb/in-language"]);

    for (const card of [...cards.languageModels, ...cards.imageModels, ...cards.embeddingModels]) {
      expect(Object.keys(card).sort()).toEqual(["description", "id", "name"]);
      expect(card.description.length).toBeLessThanOrEqual(240);
      expect(card.description).not.toContain("](");
      expect(card.description).not.toContain("https://example.com/docs");
    }
  });

  test("finds one model in full", async () => {
    const model = readModel();
    expect(await model.model("img/pix")).toEqual(languageListing[2]!);
    expect(await model.model("missing/x")).toBeNull();
  });

  test("a failed listing renders empty groups", async () => {
    expect(await readModel({ catalogStatus: 500 }).modelCards()).toEqual({
      languageModels: [],
      imageModels: [],
      embeddingModels: [],
    });
  });
});

describe("replicateCategories", () => {
  test("returns the configured models Replicate answers for", async () => {
    const categories = await readModel().replicateCategories();
    expect(categories.flatMap((category) => category.models.map((model) => `${model.owner}/${model.name}`))).toEqual([
      "minimax/speech-02-turbo",
    ]);
  });
});
