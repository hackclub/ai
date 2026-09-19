import { describe, expect, test } from "bun:test";

import type { Backend } from "../../server";
import { groupedModelCards } from "./models";

const longDescription =
  "A".repeat(230) + " see [docs](https://example.com/docs) for more " + "B".repeat(100);

const fakeBackend = {
  catalog: {
    list: async (kind: "language" | "embedding") => {
      if (kind === "language") {
        return [
          {
            id: "openai/gpt-x",
            name: "GPT X",
            description: longDescription,
            supported_parameters: ["x"],
            pricing: { prompt: "0" },
            architecture: { modality: "text->text" },
          },
          {
            id: "anthropic/claude-y",
            name: "Claude Y",
            description: longDescription,
            supported_parameters: ["x"],
            pricing: { prompt: "0" },
            architecture: { modality: "text->text" },
          },
        ];
      }
      return [];
    },
  },
} as unknown as Backend;

describe("groupedModelCards", () => {
  test("projects only id, name, description", async () => {
    const result = await groupedModelCards(fakeBackend);

    expect(result.languageModels).toHaveLength(2);
    for (const card of result.languageModels) {
      expect(Object.keys(card).sort()).toEqual(["description", "id", "name"]);
      expect(card.description.length).toBeLessThanOrEqual(240);
      expect(card.description).not.toContain("](");
      expect(card.description).not.toContain("https://example.com/docs");
    }

    expect(result.imageModels).toEqual([]);
    expect(result.embeddingModels).toEqual([]);
  });
});
