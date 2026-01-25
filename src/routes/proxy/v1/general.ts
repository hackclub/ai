import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { allowedImageModels, env } from "../../../env";
import { requireApiKey } from "../../../middleware/auth";
import { checkSpendingLimit } from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import {
  apiHeaders,
  type Ctx,
  logRequest,
  MODEL_POOL,
  type ProxyReq,
  resolveModel,
  resolveUsage,
  SIZE_RATIOS,
  standardLimiter,
} from "../shared";

const general = new Hono<{ Variables: AppVariables }>();

async function handleProxy(c: Ctx, endpoint: string) {
  const start = Date.now();
  let body: ProxyReq = { model: "unknown" };

  try {
    body = (await c.req.json()) as ProxyReq;
    body.model = resolveModel(body.model, MODEL_POOL);
    body.user = `user_${c.get("user").id}`;
    if (endpoint !== "embeddings") body.usage = { include: true };

    const res = await fetch(`${env.OPENAI_API_URL}/v1/${endpoint}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });

    if (!body.stream && endpoint !== "embeddings") {
      const data = await res.json();
      await logRequest(c, body, data, resolveUsage(data), Date.now() - start);
      return c.json(data, res.status as ContentfulStatusCode);
    }

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      const reader = res.body?.getReader(),
        decoder = new TextDecoder(),
        chunks: string[] = [];
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
          if (raw !== "[DONE]")
            try {
              const chunkUsage = resolveUsage(JSON.parse(raw));
              if (chunkUsage.total > 0 || chunkUsage.cost > 0) {
                usage = chunkUsage;
              }
            } catch {}
        }
      }
      await logRequest(
        c,
        body,
        { stream: true, content: chunks.join("\n") },
        usage,
        Date.now() - start,
      );
    });
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`${endpoint} proxy error:`, error);

    await logRequest(
      c,
      body,
      { error: error instanceof Error ? error.message : "Unknown error" },
      { prompt: 0, completion: 0, total: 0, cost: 0 },
      duration,
    );

    throw new HTTPException(500, { message: "Internal server error" });
  }
}

for (const ep of ["chat/completions", "responses", "embeddings"])
  general.post(
    `/${ep}`,
    requireApiKey,
    standardLimiter,
    checkSpendingLimit,
    (c) => handleProxy(c, ep),
  );

general.post(
  "/images/generations",
  requireApiKey,
  standardLimiter,
  checkSpendingLimit,
  async (c) => {
    const start = Date.now();
    const body = (await c.req.json()) as {
      prompt: string;
      model?: string;
      size?: string;
      response_format?: "url" | "b64_json";
    };
    const model = resolveModel(
      body.model || allowedImageModels[0],
      allowedImageModels,
    );

    const res = await fetch(`${env.OPENAI_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: body.prompt }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: SIZE_RATIOS[body.size || ""] || "1:1" },
        user: `user_${c.get("user").id}`,
        usage: { include: true },
      }),
    });

    const data = (await res.json()) as {
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      usage?: Record<string, number>;
    };
    if (!res.ok) return c.json(data, res.status as ContentfulStatusCode);

    const images = (data.choices || []).flatMap((ch) =>
      (ch.message?.images || []).flatMap((img) => {
        const url = img.image_url?.url;
        return url?.startsWith("data:")
          ? [
              body.response_format === "url"
                ? { url }
                : { b64_json: url.split(",")[1] },
            ]
          : [];
      }),
    );

    await logRequest(
      c,
      { model, stream: false },
      data,
      resolveUsage(data),
      Date.now() - start,
    );
    return c.json({ created: Math.floor(Date.now() / 1000), data: images });
  },
);

export default general;
