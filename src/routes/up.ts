import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { env } from "../env";

const up = new Hono();

interface CacheEntry {
  status: "up" | "down";
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
    return c.json(
      { status: cached.status },
      cached.status === "up" ? 200 : 503,
    );
  }

  try {
    const response = await fetch(`${env.OPENAI_API_URL}/v1/embeddings`, {
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
    });

    const status: "up" | "down" = response.ok ? "up" : "down";
    cache.set("up", { status, timestamp: now });

    return c.json({ status }, status === "up" ? 200 : 503);
  } catch {
    cache.set("up", { status: "down", timestamp: now });
    return c.json({ status: "down" }, 503);
  }
});

export default up;
