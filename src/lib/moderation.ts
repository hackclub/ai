import { env } from "../env";

// WIP see Slack: a local classifier + background moderation job is on the
// way. For now we call the OpenAI moderation API inline.

export type ModerationCategory =
  | "sexual"
  | "sexual/minors"
  | "violence"
  | "violence/graphic"
  | "harassment"
  | "harassment/threatening"
  | "hate"
  | "hate/threatening"
  | "self-harm"
  | "self-harm/intent"
  | "self-harm/instructions"
  | "illegal"
  | "drugs"
  | "illicit_drugs";

interface ModerationResult {
  flagged: boolean;
  categories: Record<ModerationCategory, boolean>;
  categoryScores?: Record<ModerationCategory, number>;
}

interface ModerationResponse {
  results: {
    flagged: boolean;
    categories: Record<ModerationCategory, boolean>;
    category_scores: Record<ModerationCategory, number>;
  }[];
}

async function triggerReview(content: string[]): Promise<ModerationResult> {
  // ArkType enforces both of these at startup (see env.ts).
  const request = await fetch(env.OPENAI_MODERATION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_MODERATION_API_KEY}`,
    },
    body: JSON.stringify({ input: content }),
  });

  if (!request.ok) {
    const text = await request.text().catch(() => "");
    throw new Error(
      `Moderation API error: ${request.status} ${request.statusText} ${text}`,
    );
  }

  try {
    const result = (await request.json()) as ModerationResponse;

    let flagged = false;
    const categories: Record<ModerationCategory, boolean> = {} as Record<
      ModerationCategory,
      boolean
    >;
    const categoryScores: Record<ModerationCategory, number> = {} as Record<
      ModerationCategory,
      number
    >;

    for (const item of result.results) {
      if (item.flagged) {
        flagged = true;
      }

      // Dynamically collect all categories from API response
      for (const cat of Object.keys(item.categories) as ModerationCategory[]) {
        categories[cat] = categories[cat] || false || item.categories[cat];
        categoryScores[cat] = Math.max(
          categoryScores[cat] || 0,
          item.category_scores[cat] || 0,
        );
      }
    }

    if (flagged) {
      console.warn("Content flagged:", categories);
    }

    return { flagged, categories, categoryScores };
  } catch (error) {
    console.error("Error occurred while parsing moderation results:", error);
    throw error;
  }
}

/**
 * Classify content using the OpenAI moderation API.
 */
export async function moderate(content: string[]): Promise<ModerationResult> {
  return triggerReview(content);
}

export function getFlaggedCategories(
  result: ModerationResult,
): ModerationCategory[] {
  return Object.keys(result.categories).filter(
    (cat) => result.categories[cat as ModerationCategory],
  ) as ModerationCategory[];
}
