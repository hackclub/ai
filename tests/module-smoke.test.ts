import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const replicateVersionsPath = path.join(
  rootDir,
  "src",
  "config",
  "allowed-replicate-model-versions.json",
);

const allowedExtensions = new Set([".ts", ".tsx"]);

function listSourceModules(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceModules(fullPath));
      continue;
    }

    const ext = path.extname(entry.name);
    if (!allowedExtensions.has(ext)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

const moduleFiles = listSourceModules(srcDir).sort();
const moduleUrls = moduleFiles.map((file) => pathToFileURL(file).href);

describe("module smoke", () => {
  beforeAll(() => {
    if (!fs.existsSync(replicateVersionsPath)) {
      fs.writeFileSync(replicateVersionsPath, "{}", "utf-8");
    }
  });

  it.each(moduleUrls)("imports %s", async (moduleUrl) => {
    const mod = await import(moduleUrl);
    expect(mod).toBeTruthy();
  });
});
