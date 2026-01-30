import fs from "node:fs";
import path from "node:path";
import { allowedReplicateModels } from "../src/config/replicate-models";
import { env } from "../src/env";

const OUTPUT_PATH = path.join(
  process.cwd(),
  "src/config/allowed-replicate-model-versions.json",
);

async function main() {
  const versionMap: Record<string, string> = {};

  console.log(
    `Generating version map for ${allowedReplicateModels.length} models...`,
  );

  for (const modelString of allowedReplicateModels) {
    const [owner, name] = modelString.split("/");
    console.log(`Fetching versions for ${owner}/${name}...`);

    try {
      const res = await fetch(
        `https://api.replicate.com/v1/models/${owner}/${name}/versions`,
        {
          headers: { Authorization: `Bearer ${env.REPLICATE_API_KEY}` },
        },
      );
      console.log("dadjasdn");

      if (!res.ok) {
        console.error(
          `Failed to fetch ${modelString}: ${res.status} ${res.statusText}`,
        );
        continue;
      }

      const data = (await res.json()) as { results: { id: string }[] };

      if (data.results) {
        for (const version of data.results) {
          versionMap[version.id] = modelString;
        }
      }
    } catch (e) {
      console.error(`Error processing ${modelString}:`, e);
    }
  }

  console.log(`Resolved ${Object.keys(versionMap).length} unique versions.`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(versionMap, null, 2));
  console.log(`Wrote map to ${OUTPUT_PATH}`);
}

main();
