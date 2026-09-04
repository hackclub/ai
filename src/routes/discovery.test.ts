import { describe, expect, test } from "bun:test";

import discovery from "./discovery";

const BASE_URL = "https://ai.hackclub.com";

const get = (path: string) => discovery.request(path);

describe("GET /robots.txt", () => {
  test("serves plain text that advertises the sitemap", async () => {
    const res = await get("/robots.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain(`Sitemap: ${BASE_URL}/sitemap.xml`);
  });
});

describe("GET /sitemap.xml", () => {
  test("serves XML listing the homepage", async () => {
    const res = await get("/sitemap.xml");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/xml; charset=utf-8",
    );

    const body = await res.text();
    expect(body).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain(`<loc>${BASE_URL}/</loc>`);
    expect(body).toContain("<lastmod>");
  });
});

describe("GET /llms.txt", () => {
  test("serves markdown that indexes the site", async () => {
    const res = await get("/llms.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await res.text()).toStartWith("# Hack Club AI");
  });
});

describe("GET /openapi.json", () => {
  test("serves a JSON OpenAPI 3.2 document", async () => {
    const res = await get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const doc = (await res.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe(BASE_URL);
    expect(doc.paths).toHaveProperty(["/proxy/v1/chat/completions"]);
  });

  test("reflects the models this deployment actually allows", async () => {
    const doc = (await (await get("/openapi.json")).json()) as {
      components: {
        schemas: {
          ChatCompletionRequest: {
            properties: { model: { examples: string[] } };
          };
        };
      };
    };

    expect(
      doc.components.schemas.ChatCompletionRequest.properties.model.examples,
    ).toEqual(["qwen/qwen3-32b", "openai/gpt-5-mini"]);
  });

  test("is also served from /.well-known/openapi.json", async () => {
    const res = await get("/.well-known/openapi.json");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { openapi: string }).openapi).toBe("3.1.0");
  });
});

describe("caching", () => {
  test("every discovery document is cacheable and has an ETag", async () => {
    for (const path of [
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/openapi.json",
    ]) {
      const res = await get(path);
      expect(res.headers.get("Cache-Control"), path).toBe(
        "public, max-age=3600",
      );
      expect(res.headers.get("ETag"), path).toBeTruthy();
    }
  });

  test("returns 304 when the client already has the current version", async () => {
    const first = await get("/llms.txt");
    const etag = first.headers.get("ETag") as string;

    const second = await discovery.request("/llms.txt", {
      headers: { "If-None-Match": etag },
    });

    expect(second.status).toBe(304);
  });
});
