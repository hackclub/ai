import type postgres from "postgres";

import type { Tables } from "../db-types";
import { log } from "../log";

/**
 * Held per image for a model no settled request has taught us about yet,
 * unless a model already learned is dearer: about what the dearest models
 * seen bill for a photo.
 */
export const UNSEEN_MODEL_IMAGE_TOKENS = 30_000;

const REFRESH_MS = 60_000;

/**
 * Prompt tokens each model is billed per image, learned from what providers
 * report. Reads come from memory: PostgreSQL, which shares what other
 * processes learned, is read once before the first image request and then
 * refreshed in the background, so a reservation never waits on it again.
 */
export class ImageTokenRates {
  private rates = new Map<string, number>();
  private loadedAt: number | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly now: () => number = Date.now,
  ) {}

  async perImage(modelId: string): Promise<number> {
    if (this.loadedAt === null) await this.refresh();
    else if (this.now() - this.loadedAt > REFRESH_MS) void this.refresh();
    return this.rates.get(modelId) ?? Math.max(UNSEEN_MODEL_IMAGE_TOKENS, ...this.rates.values());
  }

  /**
   * A higher sample is taken at once. A lower one moves the rate a sixteenth
   * of the way down, so an outlier (text the length estimate undercounts,
   * such as Chinese) wears off without one cheap image lowering the hold.
   */
  async record(modelId: string, tokensPerImage: number) {
    const [row] = await this.sql<Pick<Tables["model_image_tokens"], "tokens_per_image">[]>`
      INSERT INTO model_image_tokens (model_id, tokens_per_image)
      VALUES (${modelId}, ${tokensPerImage})
      ON CONFLICT (model_id) DO UPDATE SET
        tokens_per_image = GREATEST(
          EXCLUDED.tokens_per_image,
          model_image_tokens.tokens_per_image
            - (model_image_tokens.tokens_per_image - EXCLUDED.tokens_per_image) / 16
        ),
        samples = model_image_tokens.samples + 1,
        updated_at = now()
      RETURNING tokens_per_image
    `;
    if (row) this.rates.set(modelId, row.tokens_per_image);
  }

  private refresh() {
    this.loading ??= this.sql<Pick<Tables["model_image_tokens"], "model_id" | "tokens_per_image">[]>`
      SELECT model_id, tokens_per_image FROM model_image_tokens
    `
      .then((rows) => {
        this.rates = new Map(rows.map((row) => [row.model_id, row.tokens_per_image]));
      })
      // Without the table every model is unseen, which only over-reserves.
      .catch((error: unknown) => log.error({ err: error }, "failed to load image token rates"))
      .finally(() => {
        this.loadedAt = this.now();
        this.loading = null;
      });
    return this.loading;
  }
}
