import { describe, expect, test } from "bun:test";

import { Home } from "./home";
import { jsonForScript } from "./layout";
import { NotFound } from "./not-found";

const render = async (node: unknown): Promise<string> =>
  String(await (node as PromiseLike<string>));

const homepage = await render(Home({ models: ["qwen/qwen3-32b"] }));

const extractJsonLd = (html: string): Record<string, unknown> => {
  const match = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("no JSON-LD script tag in the rendered page");
  return JSON.parse(match[1]) as Record<string, unknown>;
};

describe("homepage JSON-LD", () => {
  test("emits exactly one parseable ld+json block", () => {
    expect(homepage.match(/type="application\/ld\+json"/g)).toHaveLength(1);
    expect(() => extractJsonLd(homepage)).not.toThrow();
  });

  test("describes Hack Club with contact details and an address", () => {
    const graph = extractJsonLd(homepage)["@graph"] as Array<
      Record<string, unknown>
    >;
    const org = graph.find((n) => n["@type"] === "Organization");

    expect(org?.name).toBe("Hack Club");
    expect(org?.address).toMatchObject({ "@type": "PostalAddress" });
    expect(Array.isArray(org?.contactPoint)).toBe(true);
  });

  test("emits no raw angle brackets inside the script element", () => {
    const raw = homepage.slice(
      homepage.indexOf('type="application/ld+json">') +
        'type="application/ld+json">'.length,
      homepage.indexOf("</script>", homepage.indexOf("ld+json")),
    );
    expect(raw).not.toContain("<");
    expect(raw).not.toContain(">");
  });

  test("jsonForScript escapes everything that could close the script tag", () => {
    const escaped = jsonForScript({
      evil: "</script><img src=x onerror=alert(1)>",
      sep: "\u2028\u2029",
    });

    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain("\u2028");
    expect(escaped).not.toContain("\u2029");
    expect(escaped).toContain("\\u003c");
    expect(JSON.parse(escaped).evil).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
  });
});

describe("discovery link tags", () => {
  test("points at the OpenAPI spec, sitemap and llms.txt", () => {
    expect(homepage).toContain('rel="service-desc"');
    expect(homepage).toContain('href="/openapi.json"');
    expect(homepage).toContain('href="/sitemap.xml"');
    expect(homepage).toContain('href="/llms.txt"');
  });

  test("has a meta description", () => {
    expect(homepage).toContain('name="description"');
  });
});

const notFoundPage = await render(NotFound({ path: "/nope" }));

describe("NotFound page", () => {
  const page = notFoundPage;

  test("names the missing path and links the recovery routes", () => {
    expect(page).toContain("/nope");
    expect(page).toContain("404");
    expect(page).toContain('href="/openapi.json"');
    expect(page).toContain('href="/llms.txt"');
    expect(page).toContain('href="https://docs.ai.hackclub.com"');
  });

  test("carries the same JSON-LD as every other page", () => {
    expect(() => extractJsonLd(page)).not.toThrow();
  });
});
