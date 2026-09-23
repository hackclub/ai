import { expect, test } from "bun:test";

import { Usd } from "../../billing/money";
import { createReplicateCatalog } from "./catalog";

test("drops models that fail to load, dedupes aliased models, and attaches pricing", async () => {
  const catalog = createReplicateCatalog({
    apiKey: "k",
    baseUrl: "https://api.example.test",
    pricing: {
      get: async (id) =>
        id === "lucataco/remove-bg"
          ? { kind: "hardware", hardware: "T4", perSecondUsd: Usd.parse("0.001"), medianRunUsd: null }
          : null,
    },
    fetch: (async (url: string) => {
      const id = String(url).replace("https://api.example.test/v1/models/", "");
      if (id === "zsxkib/dia") return new Response("gone", { status: 404 });
      // Replicate resolves the renamed ID to its new name.
      const [owner, name] = (id === "inworld/tts-1.5-mini" ? "inworld/realtime-tts-1.5-mini" : id).split("/");
      return Response.json({ url: `https://replicate.com/${owner}/${name}`, owner, name, description: "", visibility: "public" });
    }) as unknown as typeof fetch,
  });

  const models = (await catalog.categories()).flatMap((category) => category.models);
  const ids = models.map((model) => `${model.owner}/${model.name}`);
  expect(ids).not.toContain("zsxkib/dia");
  expect(ids.filter((id) => id === "inworld/realtime-tts-1.5-mini")).toHaveLength(1);
  expect(models.find((model) => model.name === "remove-bg")?.pricing).toContain("T4");
  expect(models.find((model) => model.name === "musicgen")?.pricing).toBeUndefined();
});
