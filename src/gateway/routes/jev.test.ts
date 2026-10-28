import { describe, expect, test } from "bun:test";

import { testDatabase } from "../../test/database";
import { jevRoutes } from "./jev";
import { billingRecords, createTestAccount, fakeFetch, onlyBillingRecord, post, testBilling } from "./test-harness";

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

  test("forwards a multipart image upload with the model defaulted", async () => {
    const account = await createTestAccount(sql, "jev-multipart");
    let sent: Request | undefined;
    const app = jevRoutes({
      sql,
      billing,
      settlements,
      enforceIdv: false,
      typesafeApiKey: "ts-key",
      fetch: async (input, init) => {
        sent = new Request(String(input), init);
        return Response.json({ model: "jev-1.13.0", output: "hi", usage: { input_tokens: 1_000_000, output_tokens: 0 } });
      },
    });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xd8]);
    const form = new FormData();
    form.append("request", JSON.stringify({ state: { door: "d" }, assets: { d: { part: "door" } } }));
    form.append("door", new File([image], "door.png", { type: "image/png" }));
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/jev/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${account.apiKey}`, "TypeSafe-Danger-Zone-Images": "true" },
        body: form,
      }),
    );
    await response.text();
    await settled();

    expect(response.status).toBe(200);
    expect(sent?.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
    expect(sent?.headers.get("typesafe-danger-zone-images")).toBe("true");
    const upstream = await sent!.formData();
    expect([...upstream.keys()]).toEqual(["request", "door"]);
    expect(JSON.parse(String(upstream.get("request")))).toEqual({
      model: "jev-latest",
      state: { door: "d" },
      assets: { d: { part: "door" } },
    });
    expect(new Uint8Array(await (upstream.get("door") as File).arrayBuffer())).toEqual(image);
    expect((await onlyBillingRecord(sql, account.accountId)).actualCostUsd).toBe("0.042000000000");
  });

  test("decodes a zstd multipart upload as the TypeSafe SDK sends it", async () => {
    const account = await createTestAccount(sql, "jev-zstd");
    let sent: Request | undefined;
    const app = jevRoutes({
      sql,
      billing,
      settlements,
      enforceIdv: false,
      typesafeApiKey: "ts-key",
      fetch: async (input, init) => {
        sent = new Request(String(input), init);
        return Response.json({ model: "jev-1.13.0", output: "hi", usage: { input_tokens: 1_000_000, output_tokens: 0 } });
      },
    });
    const image = crypto.getRandomValues(new Uint8Array(4096));
    const form = new FormData();
    form.append("request", JSON.stringify({ state: { door: "d" }, assets: { d: { part: "door" } } }));
    form.append("door", new File([image], "door.png", { type: "image/png" }));
    const encoded = new Response(form);
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/jev/v1/systemone", {
        method: "POST",
        headers: {
          authorization: `Bearer ${account.apiKey}`,
          "content-type": encoded.headers.get("content-type")!,
          "content-encoding": "zstd",
        },
        body: new Uint8Array(Bun.zstdCompressSync(await encoded.bytes())),
      }),
    );
    await response.text();
    await settled();

    expect(response.status).toBe(200);
    expect(sent?.headers.get("content-encoding")).toBeNull();
    const upstream = await sent!.formData();
    expect(JSON.parse(String(upstream.get("request"))).model).toBe("jev-latest");
    expect(new Uint8Array(await (upstream.get("door") as File).arrayBuffer())).toEqual(image);
    expect((await onlyBillingRecord(sql, account.accountId)).actualCostUsd).toBe("0.042000000000");
  });

  test("rejects a zstd body that decodes past the body limit before dispatch", async () => {
    const account = await createTestAccount(sql, "jev-zstd-bomb");
    const { fetch, upstream } = fakeFetch(() => Response.json({ model: "jev-1.13.0", output: "hi" }));
    const app = jevRoutes({ sql, billing, settlements, enforceIdv: false, typesafeApiKey: "ts-key", fetch, maxBodyBytes: 64 * 1024 });
    const response = await app.handle(
      new Request("http://gateway.test/proxy/v1/jev/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json", "content-encoding": "zstd" },
        body: new Uint8Array(Bun.zstdCompressSync(JSON.stringify({ input: "a".repeat(1024 * 1024) }))),
      }),
    );

    expect(response.status).toBe(413);
    expect(upstream).toHaveLength(0);
    expect(await billingRecords(sql, account.accountId)).toEqual([]);
  });

  test("a success without usable usage is charged the hold", async () => {
    const { response, record } = await call("no-usage", () => Response.json({ model: "jev-1.13.0", output: "hi" }));
    expect(response.status).toBe(200);
    expect([record.state, record.actualCostUsd, record.usageSource]).toEqual(["finalized", "0.020000000000", "fallback"]);
  });
});
