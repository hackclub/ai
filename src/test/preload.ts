import { afterAll } from "bun:test";

import { dropTestDatabases, prepareTestDatabases } from "./database";

// Fails the whole run, before any file, when PostgreSQL or ClickHouse is unreachable
// (docs/adr/0001): the engine suite must never be silently skipped.
await prepareTestDatabases();
afterAll(dropTestDatabases);
