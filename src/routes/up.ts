import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { env } from "../env";

const up = new Hono();

interface CacheEntry {
  status: "up" | "down";
  balanceRemaining?: number;
  dailyKeyUsageRemaining?: number;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 1000; // 30 seconds

const openRouterHeaders = {
  "HTTP-Referer": `${env.BASE_URL}/global?utm_source=openrouter`,
  "X-Title": "Hack Club AI",
};

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
    const embeddingResponse = await fetch(
      `${env.OPENAI_API_URL}/v1/embeddings`,
      {
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
      },
    );
    const status: "up" | "down" = embeddingResponse.ok ? "up" : "down";

    if (env.OPENROUTER_PROVISIONING_KEY) {
      const url = "https://openrouter.ai/api/v1/credits";
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${env.OPENROUTER_PROVISIONING_KEY}` },
      });
      const { data } = await response.json();
      const balanceRemaining = data.total_credits - data.total_usage;

      const keyResponse = await fetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
      });
      const keyBody = await keyResponse.json();
      const dailyKeyUsageRemaining = keyBody.limit_remaining;

      cache.set("up", {
        status,
        balanceRemaining,
        dailyKeyUsageRemaining,
        timestamp: now,
      });
      return c.json(
        { status, balanceRemaining, dailyKeyUsageRemaining },
        status === "up" ? 200 : 503,
      );
    }

    cache.set("up", { status, timestamp: now });
    return c.json({ status }, status === "up" ? 200 : 503);
  } catch {
    cache.set("up", { status: "down", timestamp: now });
    return c.json({ status: "down" }, 503);
  }
});

export default up;
