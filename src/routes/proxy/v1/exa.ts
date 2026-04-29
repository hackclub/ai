import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { env } from "../../../env";
import { isFeatureEnabled } from "../../../lib/posthog";
import { requireApiKey } from "../../../middleware/auth";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import { type Ctx, logRequest, standardLimiter } from "../shared";

const EXA_API_URL = "https://api.exa.ai";

type ExaCostDollars = {
  total?: number;
  breakDown?: Array<{
    search?: number;
    contents?: number;
    breakdown?: Record<string, number>;
  }>;
};

type ExaResponse = {
  costDollars?: ExaCostDollars;
  requestId?: string;
};

const exa = new Hono<{ Variables: AppVariables }>();

const checkExaFeature = async (c: Ctx, next: () => Promise<void>) => {
  const user = c.get("user");
  const enabled = await isFeatureEnabled(user, "enable_exa");
  if (!enabled) {
    throw new HTTPException(403, {
      message:
        "Exa access is currently in closed beta. Contact support for access.",
    });
  }
  await next();
};

exa.use(
  "/exa/*",
  requireApiKey,
  standardLimiter,
  checkExaFeature,
  checkSpendingLimit,
);

const exaHeaders = () => ({
  "Content-Type": "application/json",
  "x-api-key": env.EXA_API_KEY,
});

const resolveExaUsage = (data: unknown) => {
  const cost =
    (data as ExaResponse)?.costDollars?.total &&
    typeof (data as ExaResponse).costDollars?.total === "number"
      ? ((data as ExaResponse).costDollars?.total ?? 0)
      : 0;
  return { prompt: 0, completion: 0, total: 0, cost };
};

const labelForEndpoint = (endpoint: string) => `exa/${endpoint}`;

async function handleJsonProxy(c: Ctx, endpoint: string) {
  const start = Date.now();
  let body: Record<string, unknown> = {};

  try {
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    const res = await fetch(`${EXA_API_URL}/${endpoint}`, {
      method: "POST",
      headers: exaHeaders(),
      body: JSON.stringify(body),
    });

    const isStream =
      body.stream === true &&
      res.headers.get("content-type")?.includes("event-stream");

    if (isStream) {
      return stream(c, async (s) => {
        c.header("Content-Type", "text/event-stream");
        c.status(res.status as ContentfulStatusCode);

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        let usage = { prompt: 0, completion: 0, total: 0, cost: 0 };

        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          const part = decoder.decode(value, { stream: true });
          chunks.push(part);
          await s.write(value);

          for (const line of part
            .split("\n")
            .filter((l) => l.startsWith("data: "))) {
            const raw = line.slice(6).trim();
            if (raw && raw !== "[DONE]") {
              try {
                const parsed = JSON.parse(raw);
                const u = resolveExaUsage(parsed);
                if (u.cost > 0) usage = u;
              } catch {}
            }
          }
        }

        await logRequest(
          c,
          { model: labelForEndpoint(endpoint), stream: true },
          { stream: true, content: chunks.join("\n") },
          usage,
          Date.now() - start,
        );
      });
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (res.ok) {
      await logRequest(
        c,
        { model: labelForEndpoint(endpoint), stream: false },
        data,
        resolveExaUsage(data),
        Date.now() - start,
      );
    } else {
      await logRequest(
        c,
        { model: labelForEndpoint(endpoint), stream: false },
        data,
        { prompt: 0, completion: 0, total: 0, cost: 0 },
        Date.now() - start,
      );
    }

    return c.json(data as object, res.status as ContentfulStatusCode);
  } catch (error) {
    if (error instanceof HTTPException) throw error;

    console.error(`Exa ${endpoint} proxy error:`, error);

    await logRequest(
      c,
      { model: labelForEndpoint(endpoint), stream: false },
      { error: error instanceof Error ? error.message : "Unknown error" },
      { prompt: 0, completion: 0, total: 0, cost: 0 },
      Date.now() - start,
    );

    throw new HTTPException(500, { message: "Internal server error" });
  }
}

for (const ep of ["search", "findSimilar", "contents", "answer"]) {
  exa.post(`/exa/${ep}`, (c) => handleJsonProxy(c, ep));
}

export default exa;
