import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { allowedImageModels, env } from "../../../env";
import { getFlaggedCategories, moderate } from "../../../lib/moderation";
import {
  getUserFlagSettings,
  recordViolationEvent,
  reviewContent,
  shouldReview,
} from "../../../lib/review";
import { requireApiKey } from "../../../middleware/auth";
import {
  checkSpendingLimit,
  releasePendingCharge,
  reserveCharge,
} from "../../../middleware/limits";
import type { AppVariables } from "../../../types";
import {
  apiHeaders,
  type Ctx,
  estimateUpstreamCost,
  logRequest,
  MODEL_POOL,
  type ProxyReq,
  resolveModel,
  resolveUsage,
  SIZE_RATIOS,
  standardLimiter,
} from "../shared";

// Conservative fixed reservation for image generation. Real cost replaces
// this on log; the point is just to make a single oversized burst impossible
// when the user is already near their daily cap.
const IMAGE_GENERATION_RESERVATION = 0.25;
const UPSTREAM_HEADER_TIMEOUT_MS = 5_000;

const general = new Hono<{ Variables: AppVariables }>();

async function fetchWithHeaderTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    UPSTREAM_HEADER_TIMEOUT_MS,
  );

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HTTPException(504, {
        message: `Upstream did not return response headers within ${UPSTREAM_HEADER_TIMEOUT_MS}ms`,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type ChatMessage = {
  role?: string;
  content?: unknown;
};

type ModerationBody = {
  messages?: ChatMessage[];
  input?: unknown;
  prompt?: unknown;
};

const collectTextFromContent = (value: unknown, bucket: string[]) => {
  if (!value) return;
  if (typeof value === "string") {
    if (value.trim().length > 0) bucket.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFromContent(item, bucket);
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;

  if (typeof obj.text === "string") bucket.push(obj.text);
  if (typeof obj.input_text === "string") bucket.push(obj.input_text);
  if (typeof obj.output_text === "string") bucket.push(obj.output_text);
  if (typeof obj.content === "string") bucket.push(obj.content);

  if (Array.isArray(obj.content)) {
    collectTextFromContent(obj.content, bucket);
  }
  if (obj.message) {
    collectTextFromContent(obj.message, bucket);
  }
};

function extractContentForModeration(body: ModerationBody): string[] {
  const content: string[] = [];

  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      collectTextFromContent(msg.content, content);
    }
  }

  if (body.input) {
    collectTextFromContent(body.input, content);
  }

  if (body.prompt) {
    collectTextFromContent(body.prompt, content);
  }

  return content;
}

function extractOutputForModeration(data: unknown): string[] {
  const content: string[] = [];
  if (!data || typeof data !== "object") return content;

  const obj = data as Record<string, unknown>;
  const choices = obj.choices;
  const output = obj.output;

  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const choiceObj = choice as Record<string, unknown>;
      collectTextFromContent(choiceObj.message, content);
      collectTextFromContent(choiceObj.text, content);
      collectTextFromContent(choiceObj.delta, content);
    }
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      collectTextFromContent(item, content);
    }
  }

  collectTextFromContent(obj.output_text, content);

  return content;
}

async function handleProxy(c: Ctx, endpoint: string) {
  const start = Date.now();
  let body: ProxyReq = { model: "unknown" };
  const user = c.get("user");

  try {
    body = (await c.req.json()) as ProxyReq;
    body.model = resolveModel(body.model, MODEL_POOL);
    body.user = `user_${user.id}`;
    body.usage = { include: true };

    const flagSettings = await getUserFlagSettings(user.id);
    const reviewDecision = shouldReview(
      user.reviewStatus,
      flagSettings.optInForcedReview,
    );
    const countViolations = !flagSettings.optInForcedReview;

    if (user.reviewStatus === "banned") {
      return c.json({ error: "Account under review. Contact support." }, 403);
    }

    const inputContent = extractContentForModeration(body as ModerationBody);

    if (reviewDecision.blocking && inputContent.length > 0) {
      let inputResult = null;
      try {
        inputResult = await moderate(inputContent);
      } catch (_error) {
        throw new HTTPException(503, { message: "Moderation unavailable" });
      }

      if (inputResult?.flagged) {
        const categories = getFlaggedCategories(inputResult);
        await recordViolationEvent(
          user.id,
          "input",
          categories,
          inputContent.join(" "),
          { countTowardsUser: countViolations },
        );
        return c.json(
          {
            error: "Content prohibited by moderation",
            categories,
          },
          400,
        );
      }
    }

    // Reserve against the daily limit only once the request has passed the
    // moderation gate, so rejected requests never hold a reservation.
    await reserveCharge(c, await estimateUpstreamCost(body));

    const res = await fetchWithHeaderTimeout(
      `${env.OPENAI_API_URL}/v1/${endpoint}`,
      {
        method: "POST",
        headers: apiHeaders(c),
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      await releasePendingCharge(c);
      return c.json(errorData, res.status as ContentfulStatusCode);
    }

    const isNonStreaming = !body.stream && endpoint !== "embeddings";

    if (reviewDecision.blocking && isNonStreaming) {
      const data = (await res.json()) as unknown;
      const outputSegments = extractOutputForModeration(data);
      const outputContent = outputSegments.join(" ").trim();

      if (outputContent) {
        const outputResult = await moderate([outputContent]);
        if (outputResult.flagged) {
          const categories = getFlaggedCategories(outputResult);
          await recordViolationEvent(
            user.id,
            "output",
            categories,
            outputContent,
            { countTowardsUser: countViolations },
          );
          await releasePendingCharge(c);
          return c.json(
            {
              error: "Content prohibited by moderation",
              categories,
            },
            400,
          );
        }
      }

      await logRequest(c, body, data, resolveUsage(data), Date.now() - start);

      return c.json(data, res.status as ContentfulStatusCode);
    }

    if (isNonStreaming) {
      // For non-streaming requests, we still need to keep Cloudflare alive
      // (524 timeout ~100s). We write leading whitespace — valid before any
      // JSON document per RFC 8259 — then flush the real payload once
      // OpenRouter finishes. This is "invisible streaming": the client still
      // receives a single, normal JSON response.
      const status = res.status as ContentfulStatusCode;

      return stream(c, async (s) => {
        c.header("Content-Type", "application/json");
        c.status(status);

        // Heartbeat: write a space every 30s to prevent Cloudflare 524
        const heartbeat = setInterval(async () => {
          try {
            await s.write(" ");
          } catch {
            clearInterval(heartbeat);
          }
        }, 10_000);

        try {
          const data = (await res.json()) as unknown;
          clearInterval(heartbeat);
          await logRequest(
            c,
            body,
            data,
            resolveUsage(data),
            Date.now() - start,
          );

          const outputSegments = extractOutputForModeration(data);
          const outputContent = outputSegments.join(" ").trim();

          if (reviewDecision.shouldReview) {
            const reviewInput = inputContent.length > 0;
            const reviewOutput = outputContent.length > 0;
            if (reviewInput || reviewOutput) {
              reviewContent(user.id, inputContent, outputContent, {
                countTowardsUser: countViolations,
                reviewInput,
                reviewOutput,
              }).catch(console.error);
            }
          }

          await s.write(JSON.stringify(data));
        } catch (e) {
          clearInterval(heartbeat);
          throw e;
        }
      });
    }

    if (reviewDecision.blocking && body.stream && endpoint !== "embeddings") {
      return stream(c, async (s) => {
        c.header("Content-Type", "text/event-stream");
        c.status(res.status as ContentfulStatusCode);
        const reader = res.body?.getReader(),
          decoder = new TextDecoder(),
          chunks: string[] = [];
        let usage = { prompt: 0, completion: 0, total: 0, cost: 0 };
        let outputContent = "";

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
            if (raw !== "[DONE]") {
              try {
                const json = JSON.parse(raw);
                const chunkUsage = resolveUsage(json);
                if (chunkUsage.total > 0 || chunkUsage.cost > 0) {
                  usage = chunkUsage;
                }
                const outputSegments = extractOutputForModeration(json);
                if (outputSegments.length > 0) {
                  outputContent += outputSegments.join("");
                }
              } catch {}
            }
          }
        }
        await logRequest(
          c,
          body,
          { stream: true, content: chunks.join("\n") },
          usage,
          Date.now() - start,
        );

        // Async background review for blocking streaming
        if (outputContent.trim().length > 0) {
          const outputResult = await moderate([outputContent]);
          if (outputResult.flagged) {
            const categories = getFlaggedCategories(outputResult);
            await recordViolationEvent(
              user.id,
              "output",
              categories,
              outputContent,
              { countTowardsUser: countViolations },
            );
          }
        }
      });
    }

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      c.status(res.status as ContentfulStatusCode);
      const reader = res.body?.getReader(),
        decoder = new TextDecoder(),
        chunks: string[] = [];
      let usage = { prompt: 0, completion: 0, total: 0, cost: 0 };
      let outputContent = "";

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
          if (raw !== "[DONE]") {
            try {
              const json = JSON.parse(raw);
              const chunkUsage = resolveUsage(json);
              if (chunkUsage.total > 0 || chunkUsage.cost > 0) {
                usage = chunkUsage;
              }
              const outputSegments = extractOutputForModeration(json);
              if (outputSegments.length > 0) {
                outputContent += outputSegments.join("");
              }
            } catch {}
          }
        }
      }
      await logRequest(
        c,
        body,
        { stream: true, content: chunks.join("\n") },
        usage,
        Date.now() - start,
      );

      // Review output content if async review was scheduled
      if (reviewDecision.shouldReview) {
        const reviewInput = inputContent.length > 0;
        const reviewOutput = outputContent.trim().length > 0;
        if (reviewInput || reviewOutput) {
          reviewContent(user.id, inputContent, outputContent, {
            countTowardsUser: countViolations,
            reviewInput,
            reviewOutput,
          }).catch(console.error);
        }
      }
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

    if (error instanceof HTTPException) {
      throw error;
    }

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

    await reserveCharge(c, IMAGE_GENERATION_RESERVATION);

    const res = await fetch(`${env.OPENAI_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: apiHeaders(c),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: body.prompt }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: SIZE_RATIOS[body.size || ""] || "1:1" },
        user: `user_${c.get("user").id}`,
      }),
    });

    const data = (await res.json()) as {
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      usage?: Record<string, number>;
    };
    if (!res.ok) {
      await releasePendingCharge(c);
      return c.json(data, res.status as ContentfulStatusCode);
    }

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
