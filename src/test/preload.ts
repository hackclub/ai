import { afterAll } from "bun:test";

import { dropTestDatabases, prepareTestDatabases } from "./database";

// Fixed rules, so tests pass the same with or without the private secrets submodule.
// Test files load after this preload, so gateway/abuse.ts reads this path.
process.env.ABUSE_RULES_PATH = "src/test/abuse-rules.json";

await prepareTestDatabases();
afterAll(dropTestDatabases);
