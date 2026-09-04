import { DOCS_URL } from "./errors";

/**
 * Last time the public, indexable content of this site changed. Bump this when
 * the homepage copy, llms.txt or the published API surface changes — it is what
 * <lastmod> in the sitemap reports.
 */
export const SITE_LAST_MODIFIED = "2026-09-01";

const SITE_NAME = "Hack Club AI";
export const SITE_DESCRIPTION =
  "Free, OpenAI-compatible AI API access for Hack Clubbers. Chat completions, embeddings, image generation, moderation, OCR and web search across 30+ models.";

const ORGANIZATION_ID = "https://hackclub.com/#organization";

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * URLs on this host that are worth crawling. Every other page (/dashboard,
 * /keys, /activity, /models, /global, /replicate) redirects anonymous visitors
 * to `/`, so listing them would only advertise redirects.
 */
export const sitemapEntries = (
  baseUrl: string,
): Array<{ loc: string; changefreq: string; priority: string }> => {
  const base = trimTrailingSlash(baseUrl);
  return [
    { loc: `${base}/`, changefreq: "weekly", priority: "1.0" },
    { loc: `${base}/llms.txt`, changefreq: "weekly", priority: "0.8" },
    { loc: `${base}/openapi.json`, changefreq: "weekly", priority: "0.8" },
  ];
};

export const buildSitemap = (baseUrl: string): string => {
  const urls = sitemapEntries(baseUrl)
    .map(
      ({ loc, changefreq, priority }) =>
        `  <url>\n` +
        `    <loc>${xmlEscape(loc)}</loc>\n` +
        `    <lastmod>${SITE_LAST_MODIFIED}</lastmod>\n` +
        `    <changefreq>${changefreq}</changefreq>\n` +
        `    <priority>${priority}</priority>\n` +
        `  </url>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
};

export const buildRobotsTxt = (baseUrl: string): string => {
  const base = trimTrailingSlash(baseUrl);
  return `User-agent: *
Allow: /
Disallow: /auth/
Disallow: /internal/
Disallow: /api/

Sitemap: ${base}/sitemap.xml
`;
};

/** https://llmstxt.org — an agent-readable index of this site. */
export const buildLlmsTxt = (baseUrl: string): string => {
  const base = trimTrailingSlash(baseUrl);
  return `# ${SITE_NAME}

> ${SITE_DESCRIPTION} Run by Hack Club, a nonprofit network of high-school hackers. Sign in with a Hack Club account to get an API key; there is no charge and no credit card.

The API is OpenAI-compatible: point any OpenAI SDK at \`${base}/proxy/v1\` and pass your Hack Club AI key as a bearer token. Errors come back as JSON in the OpenAI error shape, with an extra \`error.hint\` and \`error.docs\` for recovery.

## Machine-readable

- [OpenAPI specification](${base}/openapi.json): Complete HTTP API surface, OpenAPI 3.2.
- [Sitemap](${base}/sitemap.xml): Indexable URLs on this host.
- [Health check](${base}/up): JSON service status. 200 when up, 503 when down.
- [Model list](${base}/proxy/v1/models): Live list of chat and image models. No auth required.
- [Embedding model list](${base}/proxy/v1/embeddings/models): Live list of embedding models. No auth required.

## Documentation

- [Documentation home](${DOCS_URL}): Guides and full API reference.
- [Documentation index for LLMs](${DOCS_URL}/llms.txt): The docs site's own llms.txt.
- [Authentication](${DOCS_URL}/guide/authentication): How to create and send an API key.
- [Rules and rate limiting](${DOCS_URL}/guide/rules): What is allowed, and the limits that apply.
- [Chat completions](${DOCS_URL}/api/chat-completions): POST /proxy/v1/chat/completions.
- [Responses API](${DOCS_URL}/api/responses): POST /proxy/v1/responses.
- [Embeddings](${DOCS_URL}/api/embeddings): POST /proxy/v1/embeddings.
- [Image generation](${DOCS_URL}/api/image-generation): POST /proxy/v1/images/generations.
- [Moderations](${DOCS_URL}/api/moderations): POST /proxy/v1/moderations.
- [OCR](${DOCS_URL}/api/ocr): POST /proxy/v1/ocr.
- [Web search with Exa](${DOCS_URL}/api/exa): POST /proxy/v1/exa/search and friends.
- [Replicate models](${DOCS_URL}/guide/replicate): Image, speech-to-text and text-to-speech models.

## Account

- [Home](${base}/): Product overview and sign-in.
- [Dashboard](${base}/dashboard): Usage and spending. Requires a signed-in session.
- [API keys](${base}/keys): Create and revoke keys. Requires a signed-in session.

## Optional

- [Source code](https://github.com/hackclub/ai): This proxy is open source.
- [Hack Club](https://hackclub.com): The nonprofit behind this service.
- [Hack Club Slack](https://hackclub.com/slack): Support lives in #hackclub-ai.
`;
};

/**
 * JSON-LD identity graph for the homepage: who runs this, how to reach them,
 * and what the product is. Kept as a @graph so the Organization node can be
 * referenced by @id from both the WebSite and the SoftwareApplication.
 */
export const buildStructuredData = (
  baseUrl: string,
): Record<string, unknown> => {
  const base = trimTrailingSlash(baseUrl);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        name: "Hack Club",
        legalName: "The Hack Foundation",
        description:
          "Hack Club is the world's largest nonprofit movement of teenagers making cool projects.",
        url: "https://hackclub.com",
        logo: "https://assets.hackclub.com/flag-standalone.png",
        email: "team@hackclub.com",
        telephone: "+1-855-625-4225",
        sameAs: [
          "https://github.com/hackclub",
          "https://twitter.com/hackclub",
          "https://www.youtube.com/c/HackClubHQ",
          "https://www.instagram.com/starthackclub",
          "https://en.wikipedia.org/wiki/Hack_Club",
          "https://www.wikidata.org/wiki/Q98127305",
        ],
        address: {
          "@type": "PostalAddress",
          streetAddress: "212 Battery St",
          addressLocality: "Burlington",
          addressRegion: "VT",
          postalCode: "05401",
          addressCountry: "US",
        },
        contactPoint: [
          {
            "@type": "ContactPoint",
            contactType: "general inquiries",
            email: "team@hackclub.com",
            telephone: "+1-855-625-4225",
            areaServed: "Worldwide",
            availableLanguage: "English",
          },
          {
            "@type": "ContactPoint",
            contactType: "technical support",
            email: "team@hackclub.com",
            url: "https://hackclub.com/slack",
            areaServed: "Worldwide",
            availableLanguage: "English",
          },
        ],
      },
      {
        "@type": "WebSite",
        "@id": `${base}/#website`,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        url: `${base}/`,
        inLanguage: "en",
        publisher: { "@id": ORGANIZATION_ID },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${base}/#software`,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        url: `${base}/`,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "AI API",
        operatingSystem: "Any",
        browserRequirements: "Any HTTP client",
        softwareHelp: DOCS_URL,
        installUrl: `${base}/keys`,
        featureList: [
          "OpenAI-compatible chat completions",
          "Responses API",
          "Text embeddings",
          "Image generation",
          "Content moderation",
          "OCR for images and PDFs",
          "Web search via Exa",
        ],
        provider: { "@id": ORGANIZATION_ID },
        author: { "@id": ORGANIZATION_ID },
        isAccessibleForFree: true,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
          url: `${base}/`,
        },
        potentialAction: {
          "@type": "ViewAction",
          target: `${base}/openapi.json`,
          name: "Read the OpenAPI specification",
        },
      },
    ],
  };
};
