import { afterAll } from "bun:test";

import { dropTestDatabases, prepareTestDatabases } from "./database";

await prepareTestDatabases();
afterAll(dropTestDatabases);
