import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { ErrorEnvelope } from "./errors";
import {
  buildErrorEnvelope,
  buildNotFoundMarkdown,
  createErrorHandler,
  createNotFoundHandler,
  negotiateErrorFormat,
} from "./errors";

const BASE_URL = "https://ai.hackclub.com";

const makeApp = () => {
  const options = { baseUrl: BASE_URL };
  const app = new Hono();
  app.onError(createErrorHandler(options));
  app.notFound(createNotFoundHandler(options));
  app.get("/boom", () => {
    throw new HTTPException(401, { message: "Authentication required" });
  });
  app.post("/proxy/v1/chat/completions", () => {
    throw new HTTPException(401, { message: "Authentication required" });
  });
  app.get("/explode", () => {
    throw new Error("kaboom");
  });
  return app;
};

describe("buildErrorEnvelope", () => {
  test("carries a message, code, status, hint and docs link", () => {
    const envelope: ErrorEnvelope = buildErrorEnvelope(
      401,
      "Authentication required",
    );

    expect(envelope.error.message).toBe("Authentication required");
    expect(envelope.error.type).toBe("authentication_error");
    expect(envelope.error.code).toBe("unauthorized");
    expect(envelope.error.status).toBe(401);
    expect(envelope.error.hint).toContain("Authorization: Bearer");
    expect(envelope.error.docs).toStartWith("https://docs.ai.hackclub.com");
  });

  test("includes the request id only when there is one", () => {
    expect(buildErrorEnvelope(500, "nope").request_id).toBeUndefined();
    expect(buildErrorEnvelope(500, "nope", "req_1").request_id).toBe("req_1");
  });

  test("falls back to a generic descriptor for unmapped statuses", () => {
    const envelope = buildErrorEnvelope(418, "I'm a teapot");
    expect(envelope.error.code).toBe("api_error");
    expect(envelope.error.status).toBe(418);
  });
});

describe("negotiateErrorFormat", () => {
  test("answers API paths with JSON whatever the client accepts", () => {
    expect(negotiateErrorFormat("GET", "/proxy/v1/models", "text/html")).toBe(
      "json",
    );
    expect(negotiateErrorFormat("GET", "/up", "text/html")).toBe("json");
    expect(negotiateErrorFormat("GET", "/api/keys", undefined)).toBe("json");
  });

  test("treats a path that merely starts with an API prefix as a page", () => {
    expect(negotiateErrorFormat("GET", "/apitude", "text/html")).toBe("html");
    expect(negotiateErrorFormat("GET", "/proxying", undefined)).toBe(
      "markdown",
    );
  });

  test("answers non-GET requests with JSON", () => {
    expect(negotiateErrorFormat("POST", "/anything", "text/html")).toBe("json");
    expect(negotiateErrorFormat("DELETE", "/anything", undefined)).toBe("json");
  });

  test("gives browsers HTML and everyone else markdown", () => {
    expect(
      negotiateErrorFormat(
        "GET",
        "/missing",
        "text/html,application/xhtml+xml,*/*;q=0.8",
      ),
    ).toBe("html");
    expect(negotiateErrorFormat("GET", "/missing", "*/*")).toBe("markdown");
    expect(negotiateErrorFormat("GET", "/missing", undefined)).toBe("markdown");
    expect(negotiateErrorFormat("GET", "/missing", "application/json")).toBe(
      "json",
    );
  });
});

describe("buildNotFoundMarkdown", () => {
  const body = buildNotFoundMarkdown(BASE_URL, "/nope");

  test("names the missing path", () => {
    expect(body).toContain("`/nope`");
  });

  test("points at the recovery resources agents need", () => {
    expect(body).toContain(`${BASE_URL}/llms.txt`);
    expect(body).toContain(`${BASE_URL}/openapi.json`);
    expect(body).toContain(`${BASE_URL}/sitemap.xml`);
    expect(body).toContain("https://docs.ai.hackclub.com");
  });

  test("is short enough to be cheap for an agent to read", () => {
    expect(body.length).toBeLessThan(1500);
  });
});

describe("404 handling", () => {
  test("returns 404 with a markdown body for a bare Accept header", async () => {
    const res = await makeApp().request("/some-path-that-does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );

    const body = await res.text();
    expect(body).toStartWith("# 404");
    expect(body).toContain("/llms.txt");
  });

  test("returns a JSON envelope under API prefixes", async () => {
    const res = await makeApp().request("/proxy/v1/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("not_found");
    expect(body.error.status).toBe(404);
    expect(body.error.message).toBe("No route matches GET /proxy/v1/nope");
    expect(body.error.hint).toContain("/openapi.json");
  });

  test("returns a JSON envelope for a POST to an unknown page", async () => {
    const res = await makeApp().request("/nope", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("uses the HTML renderer for browsers when one is supplied", async () => {
    const app = new Hono();
    app.notFound(
      createNotFoundHandler({
        baseUrl: BASE_URL,
        renderNotFoundPage: (c, path) => c.html(`<h1>gone: ${path}</h1>`, 404),
      }),
    );

    const res = await app.request("/missing", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("gone: /missing");
  });

  test("falls back to markdown for browsers when no renderer is supplied", async () => {
    const res = await makeApp().request("/missing", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
  });
});

describe("error handling", () => {
  test("renders an HTTPException as the JSON envelope", async () => {
    const res = await makeApp().request("/boom");

    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.message).toBe("Authentication required");
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.docs).toBe(
      "https://docs.ai.hackclub.com/guide/authentication",
    );
  });

  test("renders an API 401 as JSON, not text/plain", async () => {
    const res = await makeApp().request("/proxy/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    // OpenAI SDKs read error.type / error.message.
    expect(body.error.type).toBe("authentication_error");
  });

  test("hides unhandled errors behind a 500 envelope and reports them", async () => {
    const reported: Error[] = [];
    const app = new Hono();
    app.onError(
      createErrorHandler({
        baseUrl: BASE_URL,
        onUnhandled: (err) => reported.push(err),
      }),
    );
    app.get("/explode", () => {
      throw new Error("kaboom with a secret in it");
    });

    const res = await app.request("/explode");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Internal server error");
    expect(body.error.message).not.toContain("secret");
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toBe("kaboom with a secret in it");
  });

  test("propagates the request id set by hono's requestId middleware", async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.onError(createErrorHandler({ baseUrl: BASE_URL }));
    app.get("/boom", (c) => {
      c.set("requestId", "req_abc");
      throw new HTTPException(400, { message: "bad" });
    });

    const res = await app.request("/boom");
    const body = (await res.json()) as { request_id?: string };
    expect(body.request_id).toBe("req_abc");
  });
});
