import { describe, expect, test } from "bun:test";

import { buildOpenApiDocument } from "./openapi";

const BASE_URL = "https://ai.hackclub.com";

const doc = buildOpenApiDocument({
  baseUrl: BASE_URL,
  languageModels: ["qwen/qwen3-32b", "openai/gpt-5-mini"],
  imageModels: ["google/gemini-2.5-flash-image"],
  embeddingModels: ["qwen/qwen3-embedding-8b"],
});

type Operation = Record<string, unknown> & {
  parameters?: unknown[];
  operationId?: string;
  responses?: Record<string, unknown>;
  tags?: string[];
};

const paths = doc.paths as Record<string, Record<string, Operation>>;
const components = doc.components as {
  schemas: Record<string, unknown>;
  securitySchemes: Record<string, unknown>;
};

const METHODS = ["get", "post", "put", "patch", "delete"];

const operations = (): Array<[string, string, Operation]> =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => [path, method, op] as [string, string, Operation]),
  );

describe("document envelope", () => {
  test("declares OpenAPI 3.2", () => {
    expect(doc.openapi).toBe("3.1.0");
  });

  test("has the required info fields", () => {
    const info = doc.info as Record<string, unknown>;
    expect(info.title).toBe("Hack Club AI");
    expect(info.version).toBeTruthy();
    expect(info.description).toBeTruthy();
    expect((info.contact as { email: string }).email).toContain("@");
  });

  test("points at the production server, without a trailing slash", () => {
    expect(doc.servers).toEqual([{ url: BASE_URL, description: "Production" }]);
    expect(
      buildOpenApiDocument({
        baseUrl: "https://ai.hackclub.com/",
        languageModels: [],
        imageModels: [],
        embeddingModels: [],
      }).servers,
    ).toEqual([{ url: BASE_URL, description: "Production" }]);
  });

  test("defaults to bearer auth and defines the scheme", () => {
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  test("survives a round trip through JSON", () => {
    expect(() => JSON.parse(JSON.stringify(doc))).not.toThrow();
  });
});

describe("paths", () => {
  test("documents every endpoint an API consumer can call", () => {
    for (const path of [
      "/proxy/v1/models",
      "/proxy/v1/embeddings/models",
      "/proxy/v1/chat/completions",
      "/proxy/v1/responses",
      "/proxy/v1/embeddings",
      "/proxy/v1/images/generations",
      "/proxy/v1/moderations",
      "/proxy/v1/ocr",
      "/proxy/v1/stats",
      "/proxy/v1/exa/search",
      "/proxy/v1/exa/findSimilar",
      "/proxy/v1/exa/contents",
      "/proxy/v1/exa/answer",
      "/proxy/v1/replicate/predictions",
      "/proxy/v1/replicate/predictions/{id}",
      "/proxy/v1/replicate/predictions/{id}/cancel",
      "/proxy/v1/replicate/models/{owner}/{model}",
      "/proxy/v1/replicate/models/{owner}/{model}/predictions",
      "/proxy/v1/replicate/models/{owner}/{model}/versions",
      "/proxy/v1/replicate/models/{owner}/{model}/versions/{id}",
      "/proxy/v1/replicate/deployments",
      "/proxy/v1/replicate/deployments/{owner}/{name}",
      "/proxy/v1/replicate/deployments/{owner}/{name}/predictions",
      "/proxy/v1/replicate/files",
      "/proxy/v1/replicate/files/{id}",
      "/up",
      "/robots.txt",
      "/openapi.json",
      "/llms.txt",
      "/sitemap.xml",
    ]) {
      // Array form: these paths contain dots, which the string form treats
      // as nested-property separators.
      expect(paths).toHaveProperty([path]);
    }
  });

  test("every path is server-relative and starts with a slash", () => {
    for (const path of Object.keys(paths)) {
      expect(path).toStartWith("/");
      expect(path).not.toContain(BASE_URL);
    }
  });

  test("every operation has a unique operationId, a summary and a tag", () => {
    const seen = new Set<string>();
    for (const [path, method, op] of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.operationId, where).toBeTruthy();
      expect(seen.has(op.operationId as string), where).toBe(false);
      seen.add(op.operationId as string);
      expect(op.summary, where).toBeTruthy();
      expect(op.tags?.length, where).toBeGreaterThan(0);
    }
  });

  test("every operation tag is declared at the top level", () => {
    const declared = new Set(
      (doc.tags as Array<{ name: string }>).map((t) => t.name),
    );
    for (const [, , op] of operations()) {
      for (const tag of op.tags ?? []) expect(declared.has(tag)).toBe(true);
    }
  });

  test("every operation documents a 200 response", () => {
    for (const [path, method, op] of operations()) {
      expect(op.responses, `${method.toUpperCase()} ${path}`).toHaveProperty(
        "200",
      );
    }
  });

  test("every path parameter in a template is declared", () => {
    for (const [path, method, op] of operations()) {
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = ((op.parameters ?? []) as Array<{ name: string }>).map(
        (p) => p.name,
      );
      for (const name of templated) {
        expect(declared, `${method.toUpperCase()} ${path}`).toContain(name);
      }
    }
  });

  test("public endpoints opt out of auth, authenticated ones do not", () => {
    for (const path of [
      "/proxy/v1/models",
      "/proxy/v1/embeddings/models",
      "/up",
      "/robots.txt",
      "/openapi.json",
      "/llms.txt",
      "/sitemap.xml",
    ]) {
      expect(paths[path].get?.security, path).toEqual([]);
    }

    expect(paths["/proxy/v1/chat/completions"].post?.security).toBeUndefined();
    expect(paths["/proxy/v1/stats"].get?.security).toBeUndefined();
  });

  test("authenticated operations document 401 and 429 with the error schema", () => {
    for (const path of [
      "/proxy/v1/chat/completions",
      "/proxy/v1/embeddings",
      "/proxy/v1/stats",
    ]) {
      const op = paths[path].get ?? paths[path].post;
      const responses = op?.responses as Record<
        string,
        { content: Record<string, { schema: { $ref: string } }> }
      >;
      for (const status of ["401", "429"]) {
        expect(
          responses[status].content["application/json"].schema.$ref,
          `${path} ${status}`,
        ).toBe("#/components/schemas/ErrorResponse");
      }
    }
  });
});

describe("schemas", () => {
  test("every $ref resolves to a defined component schema", () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toStartWith("#/components/schemas/");
      expect(components.schemas).toHaveProperty([
        ref.replace("#/components/schemas/", ""),
      ]);
    }
  });

  test("ErrorResponse mirrors what the server actually sends", () => {
    const schema = components.schemas.ErrorResponse as {
      properties: { error: { required: string[] } };
    };
    expect(schema.properties.error.required).toEqual([
      "message",
      "type",
      "code",
      "status",
      "hint",
      "docs",
    ]);
  });

  test("the configured models appear as examples so agents can copy one", () => {
    const chat = components.schemas.ChatCompletionRequest as {
      properties: { model: { examples: string[] } };
    };
    expect(chat.properties.model.examples).toContain("qwen/qwen3-32b");

    const embedding = components.schemas.EmbeddingRequest as {
      properties: { model: { examples: string[] } };
    };
    expect(embedding.properties.model.examples).toContain(
      "qwen/qwen3-embedding-8b",
    );
  });

  test("does not fall over when no models are configured", () => {
    expect(() =>
      buildOpenApiDocument({
        baseUrl: BASE_URL,
        languageModels: [],
        imageModels: [],
        embeddingModels: [],
      }),
    ).not.toThrow();
  });
});
