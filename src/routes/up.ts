import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { env } from "../env";
import { openRouterHeaders } from "../lib/models";

const up = new Hono();

type CacheEntry =
  | {
      status: "down";
      timestamp: number;
    }
  | {
      status: "up";
      balanceRemaining: number;
      dailyKeyUsageRemaining: number;
      replicateUnusedCredit: number;
      timestamp: number;
    };

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 1000; // 30 seconds

const limiter = rateLimiter({
  limit: 140,
  windowMs: 60 * 60 * 1000, // 1 hour
  keyGenerator: (c) => c.req.header("CF-Connecting-IP") || "unknown",
});

up.use("/", limiter);

up.get("/", async (c) => {
  const now = Date.now();
  const cached = cache.get("up");

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return c.json(cached, cached.status === "up" ? 200 : 503);
  }

  try {
    const [embeddingResponse, creditsResponse, keyResponse, replicateResponse] =
      await Promise.all([
        fetch(`${env.OPENAI_API_URL}/v1/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            ...openRouterHeaders,
          },
          body: JSON.stringify({
            model: "thenlper/gte-base",
            input: "Health check",
            encoding_format: "float",
          }),
        }),
        fetch("https://openrouter.ai/api/v1/credits", {
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
          },
        }),
        fetch("https://openrouter.ai/api/v1/key", {
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        }),
        fetch(
          `https://replicate.com/api/users/${env.REPLICATE_USERNAME}/unused-credit`,
          { headers: { cookie: `sessionid=${env.REPLICATE_SESSION_ID}` } },
        ),
      ]);

    const [creditsBody, keyBody, replicateBody] = await Promise.all([
      creditsResponse.json() as Promise<{
        data: { total_credits: number; total_usage: number };
      }>,
      keyResponse.json() as Promise<{ data: { limit_remaining: number } }>,
      replicateResponse.json() as Promise<{ unused_credit: string }>,
    ]);

    const balanceRemaining =
      creditsBody.data.total_credits - creditsBody.data.total_usage;
    const dailyKeyUsageRemaining = keyBody.data.limit_remaining;
    const replicateUnusedCredit = parseFloat(replicateBody.unused_credit);

    const status: "up" | "down" =
      replicateUnusedCredit > 0.6 && embeddingResponse.ok ? "up" : "down";
    const cached = {
      status,
      balanceRemaining,
      dailyKeyUsageRemaining,
      replicateUnusedCredit,
      timestamp: now,
    };

    cache.set("up", cached);
    return c.json(cached, status === "up" ? 200 : 503);
  } catch {
    const cached: CacheEntry = { status: "down", timestamp: now };
    cache.set("up", cached);
    return c.json(cached, 503);
  }
});

export default up;
