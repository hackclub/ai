import { describe, expect, test } from "bun:test";

import { testDatabase } from "../../test/database";
import { jevRoutes } from "./jev";
import { createTestAccount, fakeFetch, onlyBillingRecord, post, testBilling } from "./test-harness";

const { sql } = await testDatabase();

describe("jev route", () => {
  const { billing, settlements, settled } = testBilling(sql);

  const call = async (label: string, upstream: () => Response, model?: string, headers: Record<string, string> = {}) => {
    const account = await createTestAccount(sql, `jev-${label}`);
    const { fetch, upstream: sent } = fakeFetch(upstream);
    const app = jevRoutes({ sql, billing, settlements, enforceIdv: false, typesafeApiKey: "ts-key", fetch });
    const response = await app.handle(
      post("/proxy/v1/jev/systemone", { input: "hi", ...(model ? { model } : {}) }, {
        authorization: `Bearer ${account.apiKey}`,
        ...headers,
      }),
    );
    await response.text();
    await settled();
    return { account, response, sent, record: await onlyBillingRecord(sql, account.accountId) };
  };

  test("a successful response records the versioned model it reports", async () => {
    const { account, response, record } = await call("ok", () =>
      Response.json({ model: "jev-1.13.0", output: "hello", usage: { input_tokens: 1_000_000, output_tokens: 5 } }),
    );
    expect(response.status).toBe(200);
    expect(record.state).toBe("finalized");
    expect(record.actualCostUsd).toBe("0.042000000000");
    expect(record.event?.model).toBe("jev/jev-1.13.0");
    expect(record.event?.outcome).toBe("completed");
    expect(record.event?.user_id).toBe(account.userId);
    expect(record.event?.api_key_id).toBe(account.apiKeyId);
  });

  test("a provider error keeps the requested model label", async () => {
    const { response, record } = await call("error", () =>
      Response.json({ model: "jev-1.13.0", error: "unprocessable" }, { status: 422 }),
    );
    expect(response.status).toBe(422);
    expect(record.state).toBe("finalized");
    expect(record.event?.model).toBe("jev/jev-latest");
    expect(record.event?.outcome).toBe("provider_error");
  });

  test("forwards TypeSafe's danger zone opt-in headers and the gateway's own key", async () => {
    const { sent } = await call("images", () => Response.json({ model: "jev-1.13.0", output: "hi" }), undefined, {
      "TypeSafe-Danger-Zone-Images": "true",
      "x-other": "dropped",
    });
    expect(sent[0]?.headers.get("typesafe-danger-zone-images")).toBe("true");
    expect(sent[0]?.headers.get("x-other")).toBeNull();
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer ts-key");
  });

  test("a success without usable usage is charged the hold", async () => {
    const { response, record } = await call("no-usage", () => Response.json({ model: "jev-1.13.0", output: "hi" }));
    expect(response.status).toBe(200);
    expect([record.state, record.actualCostUsd, record.usageSource]).toEqual(["finalized", "0.020000000000", "fallback"]);
  });
});
