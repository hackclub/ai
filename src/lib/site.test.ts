import { describe, expect, test } from "bun:test";

import {
  buildLlmsTxt,
  buildRobotsTxt,
  buildSitemap,
  buildStructuredData,
  SITE_LAST_MODIFIED,
  sitemapEntries,
} from "./site";

const BASE_URL = "https://ai.hackclub.com";

type JsonLdNode = Record<string, unknown> & { "@type": string };

const graphOf = (baseUrl = BASE_URL) =>
  buildStructuredData(baseUrl)["@graph"] as JsonLdNode[];

const nodeOfType = (type: string, baseUrl = BASE_URL): JsonLdNode => {
  const node = graphOf(baseUrl).find((n) => n["@type"] === type);
  if (!node) throw new Error(`no ${type} node in the JSON-LD graph`);
  return node;
};

describe("buildSitemap", () => {
  const xml = buildSitemap(BASE_URL);

  test("is a well-formed urlset", () => {
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml.trimEnd()).toEndWith("</urlset>");
    expect(xml.match(/<url>/g)).toHaveLength(sitemapEntries(BASE_URL).length);
    expect(xml.match(/<url>/g)?.length).toBe(xml.match(/<\/url>/g)?.length);
  });

  test("lists the homepage and the machine-readable entry points", () => {
    expect(xml).toContain(`<loc>${BASE_URL}/</loc>`);
    expect(xml).toContain(`<loc>${BASE_URL}/llms.txt</loc>`);
    expect(xml).toContain(`<loc>${BASE_URL}/openapi.json</loc>`);
  });

  test("gives every url a lastmod in W3C date format", () => {
    const lastmods = xml.match(/<lastmod>([^<]+)<\/lastmod>/g) ?? [];
    expect(lastmods).toHaveLength(sitemapEntries(BASE_URL).length);
    expect(SITE_LAST_MODIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(SITE_LAST_MODIFIED))).toBe(false);
  });

  test("never emits a double slash from a base url with a trailing slash", () => {
    expect(buildSitemap("https://ai.hackclub.com/")).toBe(xml);
  });

  test("stays far under the 50MB / 50,000 URL sitemap limits", () => {
    expect(sitemapEntries(BASE_URL).length).toBeLessThan(50_000);
    expect(Buffer.byteLength(xml)).toBeLessThan(50 * 1024 * 1024);
  });
});

describe("buildRobotsTxt", () => {
  const txt = buildRobotsTxt(BASE_URL);

  test("allows crawling and advertises the sitemap", () => {
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain(`Sitemap: ${BASE_URL}/sitemap.xml`);
  });

  test("keeps crawlers out of authenticated-only namespaces", () => {
    expect(txt).toContain("Disallow: /auth/");
    expect(txt).toContain("Disallow: /internal/");
  });

  test("does not block the API or the discovery files", () => {
    expect(txt).not.toContain("Disallow: /proxy");
    expect(txt).not.toContain("Disallow: /llms.txt");
    expect(txt).not.toContain("Disallow: /openapi.json");
  });
});

describe("buildLlmsTxt", () => {
  const txt = buildLlmsTxt(BASE_URL);

  test("follows the llms.txt layout: H1, blockquote, then link sections", () => {
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# Hack Club AI");
    expect(lines[2]).toStartWith("> ");
    expect(txt).toContain("\n## Machine-readable\n");
    expect(txt).toContain("\n## Documentation\n");
    expect(txt).toContain("\n## Optional\n");
  });

  test("links the openapi spec, the sitemap and the docs", () => {
    expect(txt).toContain(`(${BASE_URL}/openapi.json)`);
    expect(txt).toContain(`(${BASE_URL}/sitemap.xml)`);
    expect(txt).toContain("(https://docs.ai.hackclub.com)");
  });

  test("every bullet is a markdown link with a description", () => {
    const bullets = txt.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(10);
    for (const bullet of bullets) {
      expect(bullet).toMatch(/^- \[[^\]]+\]\([^)]+\): .+$/);
    }
  });
});

describe("buildStructuredData", () => {
  test("is a schema.org graph", () => {
    const data = buildStructuredData(BASE_URL);
    expect(data["@context"]).toBe("https://schema.org");
    expect(Array.isArray(data["@graph"])).toBe(true);
  });

  test("describes the Organization, the WebSite and the product", () => {
    const types = graphOf().map((n) => n["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
  });

  test("Organization carries a contactPoint with an email and contactType", () => {
    const org = nodeOfType("Organization");
    const contactPoints = org.contactPoint as Array<Record<string, string>>;

    expect(contactPoints.length).toBeGreaterThan(0);
    for (const point of contactPoints) {
      expect(point["@type"]).toBe("ContactPoint");
      expect(point.contactType).toBeTruthy();
      expect(point.email).toContain("@");
    }
    expect(contactPoints.some((p) => Boolean(p.telephone))).toBe(true);
  });

  test("Organization carries a PostalAddress", () => {
    const address = nodeOfType("Organization").address as Record<
      string,
      string
    >;

    expect(address["@type"]).toBe("PostalAddress");
    for (const field of [
      "streetAddress",
      "addressLocality",
      "addressRegion",
      "postalCode",
      "addressCountry",
    ]) {
      expect(address[field]).toBeTruthy();
    }
  });

  test("Organization has the identity fields an agent needs", () => {
    const org = nodeOfType("Organization");
    expect(org.name).toBe("Hack Club");
    expect(org.url).toBe("https://hackclub.com");
    expect(org.description).toBeTruthy();
    expect(org.logo).toBeTruthy();
    expect((org.sameAs as string[]).length).toBeGreaterThan(2);
  });

  test("SoftwareApplication states it is free and points back to the Organization", () => {
    const app = nodeOfType("SoftwareApplication");
    const offers = app.offers as Record<string, string>;

    expect(app.name).toBe("Hack Club AI");
    expect(app.url).toBe(`${BASE_URL}/`);
    expect(app.isAccessibleForFree).toBe(true);
    expect(offers.price).toBe("0");
    expect(offers.priceCurrency).toBe("USD");
    expect(app.provider).toEqual({ "@id": nodeOfType("Organization")["@id"] });
  });

  test("every @id reference resolves to a node in the graph", () => {
    const ids = new Set(graphOf().map((n) => n["@id"]));
    for (const node of graphOf()) {
      for (const value of Object.values(node)) {
        const ref = (value as { "@id"?: string })?.["@id"];
        if (ref && node["@id"] !== ref) expect(ids.has(ref)).toBe(true);
      }
    }
  });

  test("serialises to JSON with no script-breaking sequences", () => {
    const json = JSON.stringify(buildStructuredData(BASE_URL));
    expect(json).not.toContain("</script");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("normalises a base url with a trailing slash", () => {
    expect(nodeOfType("WebSite", "https://ai.hackclub.com/")["@id"]).toBe(
      `${BASE_URL}/#website`,
    );
  });
});
