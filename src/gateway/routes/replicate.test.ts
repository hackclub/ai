import { describe, expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { allowedReplicateModelVersions } from "../../config/allowed-replicate-model-versions";
import { allowedReplicateModels } from "../../config/replicate-models";
import { blockedPrompts } from "../../config/blocked-prompts";
import type { Fetch } from "../../providers/openrouter/adapter";
import type { ReplicatePricing } from "../../providers/replicate/pricing";
import { BLOCKED_MESSAGE } from "../abuse";
import {
  replicateRoutes,
  resolveModelReference,
  rewriteUpstreamLinks,
  validateModelAccess,
  validateVersionAccess,
  versionFromModelName,
  type ReplicateRouteDependencies,
} from "./replicate";
import { testDatabase } from "../../test/database";
import {
  billingRecords,
  createTestAccount,
  onlyBillingRecord,
  post,
  testBilling,
} from "./test-harness";

const { sql } = await testDatabase();

const knownVersion = Object.keys(allowedReplicateModelVersions)[0] ?? "";
const knownModel = allowedReplicateModelVersions[knownVersion] ?? "";

const pricing: ReplicatePricing = {
  kind: "hardware",
  hardware: "T4",
  perSecondUsd: Usd.parse("0.001"),
  medianRunUsd: Usd.parse("0.002"),
};

describe("Replicate allowlist", () => {
  test("accepts listed models and strips version suffixes", () => {
    const [owner, name] = knownModel.split("/");
    expect(validateModelAccess(owner ?? "", `${name}:${knownVersion}`)).toBe(knownModel);
    expect(versionFromModelName(`${name}:${knownVersion}`)).toBe(knownVersion);
    expect(versionFromModelName(name ?? "")).toBeUndefined();
  });

  test("rejects unlisted models and mismatched versions", () => {
    expect(() => validateModelAccess("evil", "model")).toThrow(
      "Model evil/model is not in the allowed list.",
    );
    expect(() => validateVersionAccess("other/model", knownVersion)).toThrow(
      `Model other/model:${knownVersion} is not in the allowed list.`,
    );
    expect(() => validateVersionAccess(knownModel, knownVersion)).not.toThrow();
  });

  test("resolves every version form Replicate accepts against the allowlist", () => {
    const canonical = `${knownModel}:${knownVersion}`;
    expect(resolveModelReference(knownVersion)).toEqual({ model: knownModel, version: canonical });
    expect(resolveModelReference(canonical)).toEqual({ model: knownModel, version: canonical });
    expect(resolveModelReference(knownModel)).toEqual({ model: knownModel, version: null });
    // An unknown version id, or a known model paired with someone else's version, is refused.
    expect(() => resolveModelReference("a".repeat(64))).toThrow("is not in the allowed list");
    expect(() => resolveModelReference(`${knownModel}:${"a".repeat(64)}`)).toThrow(
      "is not in the allowed list",
    );
    expect(() => resolveModelReference("black-forest-labs/flux-1.1-pro")).toThrow(
      "is not in the allowed list",
    );
    expect(() => resolveModelReference("nonsense")).toThrow("Invalid model format.");
  });

  test("every allowlisted version belongs to an allowlisted model", () => {
    for (const model of Object.values(allowedReplicateModelVersions)) {
      expect(allowedReplicateModels).toContain(model);
    }
  });
});

describe("rewriteUpstreamLinks", () => {
  const from = "https://api.replicate.com/v1/";
  const to = "https://gateway.test/proxy/v1/replicate/";

  test("points API links at the gateway but leaves model data and stream links alone", () => {
    const prediction = {
      id: "p1",
      urls: {
        get: `${from}predictions/p1`,
        cancel: `${from}predictions/p1/cancel`,
        stream: "https://stream.replicate.com/v1/files/abc",
        web: "https://replicate.com/p/p1",
      },
      input: { get: `${from}predictions/other` },
      output: [`${from}predictions/other`],
    };
    expect(rewriteUpstreamLinks(prediction, from, to)).toEqual({
      ...prediction,
      urls: {
        ...prediction.urls,
        get: `${to}predictions/p1`,
        cancel: `${to}predictions/p1/cancel`,
      },
    });
    expect(rewriteUpstreamLinks({ next: `${from}models/a/b/versions?cursor=x`, previous: null, results: [] }, from, to))
      .toEqual({ next: `${to}models/a/b/versions?cursor=x`, previous: null, results: [] });
  });
});

/**
 * A fresh account per test on the real engine and database, so ownership,
 * quota and billing are all real rows the test reads back.
 */
const setup = async () => {
  const account = await createTestAccount(sql, crypto.randomUUID());
  const { billing, settlements, settled } = testBilling(sql);
  const auth = { authorization: `Bearer ${account.apiKey}` };

  const buildApp = (deps: Partial<ReplicateRouteDependencies> & { fetch: Fetch }) =>
    replicateRoutes({
      sql,
      billing,
      settlements,
      replicateApiKey: "test-key",
      enforceIdv: false,
      pricing: { get: async () => pricing },
      ...deps,
    });
  type App = ReturnType<typeof buildApp>;

  const postPrediction = (app: App, body: unknown) =>
    app.handle(post("/proxy/v1/replicate/predictions", body, auth));

  const uploadFile = (app: App, content: BlobPart = new Uint8Array(8)) => {
    const form = new FormData();
    form.append("content", new Blob([content]), "upload.bin");
    return app.handle(
      new Request("http://gateway.test/proxy/v1/replicate/files", { method: "POST", headers: auth, body: form }),
    );
  };

  const ownedResources = async () =>
    [
      ...(await sql<{ kind: string; id: string }[]>`
        SELECT kind, id FROM replicate_resources WHERE user_id = ${account.userId}::uuid ORDER BY created_at, id
      `),
    ];

  return {
    account,
    settled,
    buildApp,
    postPrediction,
    uploadFile,
    ownedResources,
    records: () => billingRecords(sql, account.accountId),
    record: () => onlyBillingRecord(sql, account.accountId),
  };
};

const refuseFetch = (calls: string[] = []): Fetch => async (input) => {
  calls.push(String(input));
  throw new Error("upstream must not be called");
};

/** Longer than `replicate_resources.id` allows, so the real ownership insert fails. */
const unrecordableId = (prefix: string) => prefix.repeat(129);

describe("POST /predictions", () => {
  test("returns the prediction even when recording ownership fails, and reports it", async () => {
    const { buildApp, postPrediction, settled, record, ownedResources } = await setup();
    const id = unrecordableId("p");
    const errors: unknown[] = [];
    const app = buildApp({
      fetch: async (input) => {
        const url = String(input);
        if (!url.includes(`/v1/models/${knownModel}/predictions`)) throw new Error(`Unexpected fetch: ${url}`);
        return Response.json({ id, status: "succeeded", metrics: { predict_time: 1 }, urls: {} }, { status: 201 });
      },
      onSettlementError: (error) => errors.push(error),
    });

    const response = await postPrediction(app, { version: knownModel, input: {} });

    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBe(id);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain(id);
    expect(await ownedResources()).toEqual([]);
    // The prediction ran, so it is still billed from its metrics.
    await settled();
    expect(await record()).toMatchObject({
      state: "finalized",
      provider: "replicate",
      providerRequestId: id,
      actualCostUsd: "0.001000000000",
      usageSource: "provider_reported",
    });
  });

  test("refuses a blocked prompt before billing or upstream", async () => {
    const { buildApp, postPrediction, records } = await setup();
    const fetchCalls: string[] = [];
    const response = await postPrediction(buildApp({ fetch: refuseFetch(fetchCalls) }), {
      version: knownModel,
      input: { prompt: blockedPrompts[0] },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: BLOCKED_MESSAGE });
    expect(fetchCalls).toEqual([]);
    expect(await records()).toEqual([]);
  });

  test("rejects webhook fields before billing or upstream", async () => {
    const { buildApp, postPrediction, records } = await setup();
    const fetchCalls: string[] = [];
    const response = await postPrediction(buildApp({ fetch: refuseFetch(fetchCalls) }), {
      version: knownModel,
      input: {},
      webhook: "https://attacker.example/hook?secret=1",
    });
    expect(response.status).toBe(400);
    expect(fetchCalls).toEqual([]);
    expect(await records()).toEqual([]);
  });
});

describe("POST /files", () => {
  const created = (id: string): Fetch => async () => Response.json({ id }, { status: 201 });

  test("enforces the upload size limit before contacting Replicate", async () => {
    const { buildApp, uploadFile, settled, records } = await setup();
    const fetchCalls: string[] = [];
    const over = await uploadFile(buildApp({ maxUploadBytes: 16, fetch: refuseFetch(fetchCalls) }), new Uint8Array(17));
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toContain("upload limit");
    expect(fetchCalls).toEqual([]);
    expect(await records()).toEqual([]);

    const atLimit = await uploadFile(buildApp({ maxUploadBytes: 16, fetch: created("f1") }), new Uint8Array(16));
    expect(atLimit.status).toBe(201);
    await atLimit.text();
    await settled();
    expect((await records()).map((record) => record.state)).toEqual(["finalized"]);
  });

  test("caps uploads per user over the last 24 hours", async () => {
    const { account, buildApp, uploadFile } = await setup();
    const other = await createTestAccount(sql, crypto.randomUUID());
    const insertFiles = (userId: string, count: number, age: string) => sql`
      INSERT INTO replicate_resources (kind, id, user_id, created_at)
      SELECT 'file', ${userId} || '-' || ${age} || '-' || n, ${userId}::uuid, now() - ${age}::interval
      FROM generate_series(1, ${count}) AS n
    `;
    // 199 recent uploads plus older ones and another user's: still under the cap.
    await insertFiles(account.userId, 199, "1 hour");
    await insertFiles(account.userId, 5, "25 hours");
    await insertFiles(other.userId, 5, "1 hour");
    expect((await uploadFile(buildApp({ fetch: created(`f-${crypto.randomUUID()}`) }))).status).toBe(201);

    // That upload was the 200th in 24 hours.
    const fetchCalls: string[] = [];
    expect((await uploadFile(buildApp({ fetch: refuseFetch(fetchCalls) }))).status).toBe(429);
    expect(fetchCalls).toEqual([]);
  });

  test("keeps the file id when the ownership insert fails", async () => {
    const { buildApp, uploadFile, ownedResources } = await setup();
    const id = unrecordableId("f");
    const errors: unknown[] = [];
    const app = buildApp({ fetch: created(id), onSettlementError: (error) => errors.push(error) });
    const response = await uploadFile(app);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBe(id);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain(id);
    expect(await ownedResources()).toEqual([]);
  });

  test("records an upload as a zero-cost metered request without its bytes, owned by its uploader", async () => {
    const { buildApp, uploadFile, settled, record, ownedResources } = await setup();
    const response = await uploadFile(buildApp({ fetch: created("f3") }), Buffer.from("secret file bytes"));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await response.text();
    await settled();
    const upload = await record();
    expect(upload).toMatchObject({
      state: "finalized",
      provider: "replicate-files",
      providerRequestId: "f3",
      estimatedCostUsd: "0.000000000000",
      actualCostUsd: "0.000000000000",
    });
    expect(String(upload.event?.request_body)).not.toContain("secret file bytes");
    expect(await ownedResources()).toEqual([{ kind: "file", id: "f3" }]);
  });

  test("records an upstream failure at zero cost", async () => {
    const { buildApp, uploadFile, settled, record, ownedResources } = await setup();
    const app = buildApp({ fetch: async () => new Response("upstream failure", { status: 500 }) });
    const response = await uploadFile(app);
    expect(response.status).toBe(500);
    await response.text();
    await settled();
    const failure = await record();
    expect(failure).toMatchObject({ state: "finalized", actualCostUsd: "0.000000000000" });
    expect(failure.event?.outcome).toBe("provider_error");
    expect(await ownedResources()).toEqual([]);
  });
});
