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
import { type DashboardEnv, DashboardReadModel, parseActivityCursor, parseActivityFilters } from "./read-model";

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

// A 1×1 PNG.
const COVER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const replicateFetch = (coverResponse: () => Response) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://replicate.test/v1/models/minimax/speech-02-turbo") {
      return Response.json({
        owner: "minimax",
        name: "speech-02-turbo",
        url: "",
        description: "TTS",
        visibility: "public",
        cover_image_url: "https://replicate.test/cover.png",
      });
    }
    if (url === "https://replicate.test/cover.png") return coverResponse();
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

/** A real read model over the test datastores; AnalyticsQueries is rebuilt per call since it memoizes. */
const readModel = (options: { env?: DashboardEnv; catalogStatus?: number; coverResponse?: () => Response } = {}) =>
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
      fetch: replicateFetch(options.coverResponse ?? (() => new Response("not found", { status: 404 }))),
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
      provider: "",
      endpoint: "",
      model: "openai/gpt-x",
      modelName: "GPT X",
      variant: null,
      modelHref: "/models/openai/gpt-x",
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
    expect(unlistedRow).toMatchObject({ modelName: "nobody/unlisted", modelHref: null, apiKeyName: "revoked key", error: "rate_limited" });
    expect(embeddingRow).toMatchObject({ modelName: "Emb Endpoint", apiKeyName: "Active key", error: null });
  });

  test("names routing variants after their base model and links other providers to their page", async () => {
    const user = await signedIn();
    const nitro = event(user.billingAccountId, { provider: "openrouter", model: "openai/gpt-x:nitro" });
    const unlistedVariant = event(user.billingAccountId, { provider: "openrouter", model: "nobody/unlisted:free" });
    const jev = event(user.billingAccountId, { provider: "typesafe", model: "jev/jev-latest" });
    const ocr = event(user.billingAccountId, { provider: "mistral", model: "mistral-ocr-latest" });
    await insertEvents([nitro, unlistedVariant, jev, ocr]);

    const rows = (await readModel().activity(user)).rows;
    expect(rows.map(({ modelName, variant, modelHref }) => ({ modelName, variant, modelHref }))).toEqual([
      { modelName: "mistral-ocr-latest", variant: null, modelHref: "/ocr" },
      { modelName: "jev/jev-latest", variant: null, modelHref: "/jev" },
      { modelName: "nobody/unlisted", variant: "free", modelHref: null },
      { modelName: "GPT X", variant: "nitro", modelHref: "/models/openai/gpt-x" },
    ]);
  });

  test("filters by result, key, model and search, and pages within the filter", async () => {
    const user = await signedIn();
    const key = await issueApiKey(sql, user.id, "Filtered key");
    const matching = Array.from({ length: 51 }, () =>
      event(user.billingAccountId, { api_key_id: key.id, model: "acme/unnamed" }),
    );
    const failed = event(user.billingAccountId, { outcome: "provider_error", error_code: "http_400", model: "emb/endpoint" });
    const otherKey = event(user.billingAccountId);
    await insertEvents([...matching, failed, otherKey]);
    const model = readModel();
    const ids = async (filters: Record<string, string>) =>
      (await model.activity(user, { filters: parseActivityFilters(new URLSearchParams(filters)) })).rows.map(
        (row) => row.requestId,
      );

    expect(await ids({ status: "error" })).toEqual([failed.request_id]);
    expect(await ids({ model: "emb/endpoint" })).toEqual([failed.request_id]);
    expect(await ids({ q: "HTTP_400" })).toEqual([failed.request_id]);
    expect(await ids({ q: failed.request_id.slice(0, 8) })).toEqual([failed.request_id]);
    expect(await ids({ q: "UNNAMED", status: "ok", key: "not-a-uuid" })).toHaveLength(50);

    const filters = parseActivityFilters(new URLSearchParams({ q: "unnamed" }));
    const first = await model.activity(user, { filters });
    expect(first.rows).toHaveLength(50);
    const rest = await model.activity(user, { filters, cursor: first.next ?? undefined });
    expect(rest.rows.map((row) => row.requestId)).toEqual([matching[0]?.request_id]);
    expect(rest.next).toBeNull();
  });

  test("offers the account's models and keys as filters", async () => {
    const user = await signedIn();
    const key = await issueApiKey(sql, user.id, "Laptop");
    await insertEvents([
      event(user.billingAccountId, { model: "openai/gpt-x:nitro" }),
      event(user.billingAccountId, { model: "nobody/unlisted" }),
      event(user.billingAccountId, { model: "nobody/unlisted" }),
      event((await signedIn()).billingAccountId, { model: "emb/endpoint" }),
    ]);
    expect(await readModel().activityFilterOptions(user)).toEqual({
      models: [
        { id: "nobody/unlisted", name: "nobody/unlisted" },
        { id: "openai/gpt-x:nitro", name: "GPT X (nitro)" },
      ],
      keys: [{ id: key.id, name: "Laptop" }],
    });
  });

  test("shows one request's details only to its owner", async () => {
    const user = await signedIn();
    const other = await signedIn();
    const request = event(user.billingAccountId, {
      provider: "openrouter",
      streamed: true,
      time_to_first_byte_ms: 120,
      duration_ms: 620,
      http_status: 200,
      request_headers: { "user-agent": "curl/8.7.1" },
    });
    await insertEvents([request]);
    const model = readModel();

    expect(await model.activityRequest(user, request.request_id)).toMatchObject({
      requestId: request.request_id,
      modelName: "GPT X",
      provider: "openrouter",
      httpStatus: 200,
      streamed: true,
      timeToFirstByteMs: 120,
      durationMs: 620,
      userAgent: "curl/8.7.1",
    });
    expect(await model.activityRequest(other, request.request_id)).toBeNull();
    expect(await model.activityRequest(user, "not-a-uuid")).toBeNull();
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
    const rest = await model.activity(user, { cursor: cursor ?? undefined });
    expect(rest.rows.map((row) => row.requestId)).toEqual([events[0]?.request_id]);
    expect(rest.next).toBeNull();
  });

  test("a full last page has no next cursor", async () => {
    const user = await signedIn();
    await insertEvents(Array.from({ length: 50 }, () => event(user.billingAccountId)));
    expect((await readModel().activity(user)).next).toBeNull();
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
  test("totals the user's requests", async () => {
    const user = await signedIn();
    const other = await signedIn();
    await insertEvents([
      event(user.billingAccountId, { input_tokens: 10, output_tokens: 5 }),
      event(user.billingAccountId, { input_tokens: 20, output_tokens: 7 }),
      event(other.billingAccountId, { input_tokens: 1, output_tokens: 1 }),
    ]);

    expect(await readModel().usage(user)).toEqual({
      totalRequests: 2,
      totalTokens: 42,
      totalPromptTokens: 30,
      totalCompletionTokens: 12,
    });
  });

  test("ranks global usage by model and author, folding routing variants into their base model, and charts the selected range", async () => {
    const user = await signedIn();
    const other = await signedIn();
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    await insertEvents([
      event(user.billingAccountId, { occurred_at: at(0), provider: "openrouter", model: "openai/gpt-x", input_tokens: 60, output_tokens: 20 }),
      event(other.billingAccountId, { occurred_at: at(0), provider: "openrouter", model: "openai/gpt-x:nitro", input_tokens: 10, output_tokens: 10 }),
      event(other.billingAccountId, { occurred_at: at(3), provider: "openrouter", model: "acme/unnamed", input_tokens: 50, output_tokens: 0 }),
      event(user.billingAccountId, { occurred_at: at(3), provider: "typesafe", model: "jev-latest", input_tokens: 5, output_tokens: 0 }),
      event(user.billingAccountId, { occurred_at: at(3), provider: "exa", model: "exa/search", input_tokens: 0, output_tokens: 0 }),
      event(user.billingAccountId, { occurred_at: at(40), provider: "openrouter", model: "openai/gpt-x", input_tokens: 1000, output_tokens: 0 }),
    ]);
    const model = readModel();

    const day = await model.globalUsage("day", now);
    expect(day.totals).toEqual({ requests: 2, tokens: 100, users: 2 });
    expect(day.models).toEqual([
      { model: "openai/gpt-x", name: "GPT X", href: "/models/openai/gpt-x", requests: 2, tokens: 100, share: 1 },
    ]);
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    expect(day.series.map((series) => series.model)).toEqual(["openai/gpt-x"]);
    expect(day.bars).toHaveLength(24);
    expect(day.bars.at(-1)).toMatchObject({ start: hour.toISOString().replace(".000Z", "Z"), total: 100 });

    const month = await model.globalUsage("month", now);
    expect(month.totals).toEqual({ requests: 5, tokens: 155, users: 2 });
    expect(month.models.map((row) => [row.model, row.tokens, row.href])).toEqual([
      ["openai/gpt-x", 100, "/models/openai/gpt-x"],
      ["acme/unnamed", 50, "/models/acme/unnamed"],
      ["jev-latest", 5, null],
    ]);
    expect(month.authors.map((row) => [row.author, row.tokens])).toEqual([
      ["openai", 100],
      ["acme", 50],
      ["typesafe", 5],
    ]);
    expect(month.series.map((series) => series.model)).toEqual(["openai/gpt-x", "acme/unnamed", "jev-latest"]);
    expect(month.bars).toHaveLength(30);
    expect(month.bars.at(-1)).toMatchObject({
      start: `${now.toISOString().slice(0, 10)}T00:00:00Z`,
      total: 100,
      tokens: { "openai/gpt-x": 100 },
    });
    expect(month.bars.at(-4)?.total).toBe(55);
    expect(month.bars.reduce((sum, bar) => sum + bar.total, 0)).toBe(155);

    const all = await model.globalUsage("all", now);
    expect(all.totals.tokens).toBe(1155);
    expect(all.bars[0]?.start).toBe(`${at(40).slice(0, 7)}-01T00:00:00Z`);
    expect(all.bars.at(-1)?.start).toBe(`${now.toISOString().slice(0, 7)}-01T00:00:00Z`);
    expect(all.bars.reduce((sum, bar) => sum + bar.total, 0)).toBe(1155);
  });

  test("one read model caches each account's totals separately", async () => {
    const user = await signedIn();
    const other = await signedIn();
    await insertEvents([
      event(user.billingAccountId, { input_tokens: 10, output_tokens: 5 }),
      event(other.billingAccountId, { input_tokens: 1, output_tokens: 1 }),
    ]);

    const model = readModel();
    expect((await model.usage(user)).totalTokens).toBe(15);
    expect((await model.usage(other)).totalTokens).toBe(2);
    expect((await model.usage(user)).totalTokens).toBe(15);
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

  test("a failed listing renders empty groups", async () => {
    expect(await readModel({ catalogStatus: 500 }).modelCards()).toEqual({
      languageModels: [],
      imageModels: [],
      embeddingModels: [],
    });
  });
});

describe("replicateCategories", () => {
  test("returns card fields for the configured models Replicate answers for", async () => {
    const categories = await readModel().replicateCategories();
    expect(categories.flatMap((category) => category.models)).toEqual([
      { owner: "minimax", name: "speech-02-turbo", description: "TTS", pricing: null, cover: "/replicate/covers/minimax/speech-02-turbo" },
    ]);
  });

  test("serves covers as card-sized WebP, and the original when it cannot be re-encoded", async () => {
    const png = await new Bun.Image(Uint8Array.fromBase64(COVER_PNG)).resize(1600, 900, { fit: "fill" }).png().blob();
    let cover: Response = new Response(png);
    const model = readModel({ coverResponse: () => cover.clone() });

    const thumbnail = await model.replicateCover("minimax", "speech-02-turbo");
    if (!thumbnail || !("image" in thumbnail)) throw new Error("expected a thumbnail");
    expect(thumbnail.image.type).toBe("image/webp");
    expect(await new Bun.Image(await thumbnail.image.arrayBuffer()).metadata()).toMatchObject({ width: 640, height: 360 });

    cover = new Response("GIF89a");
    const gif = readModel({ coverResponse: () => cover.clone() });
    expect(await gif.replicateCover("minimax", "speech-02-turbo")).toEqual({ redirect: "https://replicate.test/cover.png" });
    expect(await gif.replicateCover("minimax", "unlisted")).toBeNull();
  });
});
