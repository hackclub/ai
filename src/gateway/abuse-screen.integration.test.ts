import { expect, test } from "bun:test";

import fixture from "../test/abuse-rules.json";
import { testDatabase } from "../test/database";
import { abuseRules, BLOCKED_MESSAGE, parseAbuseRules } from "./abuse";
import { learnedFingerprints, pruneAbuseEvents } from "./abuse-events";
import { createAbuseScreen, screenRequest } from "./abuse-screen";
import { createTestAccount } from "./routes/test-harness";

const { sql } = await testDatabase();
const [prompt] = fixture.prompts["Test agent"] as [string];

const principal = async () => {
  const account = await createTestAccount(sql, crypto.randomUUID());
  return { userId: account.userId, apiKeyId: account.apiKeyId, billingAccountId: account.accountId };
};
/**
 * An agent's tools: five with parameters, so the request has a fingerprint.
 * The fingerprint ignores names, so each test passes its own `agent`.
 */
const tools = (agent: string, prefix = "") =>
  ["read", "write", "shell", "plan", "fetch"].map((name) => ({
    type: "function",
    function: { name: `${prefix}${name}`, parameters: { type: "object", properties: { [`${agent}_${name}`]: {}, reason: {} } } },
  }));
const request = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: new Headers(headers),
  endpoint: "/proxy/v1/chat/completions",
  ip: "203.0.113.9",
  body: JSON.stringify(body),
});
const refused = async (screen: typeof screenRequest, who: Awaited<ReturnType<typeof principal>>, body: unknown) => {
  try {
    await screen(sql, who, request(body));
    return false;
  } catch (error) {
    expect((error as Error).message).toBe(BLOCKED_MESSAGE);
    return true;
  }
};
const eventsOf = (userId: string) =>
  sql<{ kind: string; rule: string; enforced: boolean; ip: string; toolset_fingerprint: string | null }[]>`
    SELECT kind, rule, enforced, ip, toolset_fingerprint FROM abuse_events WHERE user_id = ${userId}::uuid ORDER BY id
  `;

test("a refused agent's toolset is refused again once its prompt is gone, for anyone", async () => {
  const [evader, other] = [await principal(), await principal()];
  const agent = tools("evader", "x_");
  expect(await refused(screenRequest, evader, { messages: [{ role: "system", content: prompt }], tools: agent })).toBeTrue();
  // The same tools, renamed, and the prompt stripped.
  const renamed = tools("evader", "renamed_");
  expect(await refused(screenRequest, evader, { messages: [{ role: "user", content: "hi" }], tools: renamed })).toBeTrue();
  expect(await refused(screenRequest, other, { messages: [{ role: "user", content: "hi" }], tools: renamed })).toBeTrue();
  expect(await refused(screenRequest, other, { messages: [{ role: "user", content: "hi" }], tools: tools("evader").slice(0, 4) })).toBeFalse();

  const [first, second] = await eventsOf(evader.userId);
  expect(first).toMatchObject({ kind: "prompt", rule: "Test agent", enforced: true, ip: "203.0.113.9" });
  expect(first!.toolset_fingerprint).toMatch(/^[0-9a-f]{32}$/);
  expect(second).toMatchObject({ kind: "learned_toolset", rule: first!.toolset_fingerprint, enforced: true });

  // Another replica learns it from the database.
  const fresh = createAbuseScreen(abuseRules);
  const third = await principal();
  expect(await refused(fresh, third, { messages: [{ role: "user", content: "hi" }], tools: renamed })).toBeTrue();
});

test("deleting the rule that taught a fingerprint forgets it", async () => {
  const who = await principal();
  const agent = tools("forgettable");
  const rules = parseAbuseRules({ ...fixture, prompts: { "Forgettable agent": ["You are the forgettable agent of this test file."] } });
  const screen = createAbuseScreen(rules);
  expect(
    await refused(screen, who, { messages: [{ role: "system", content: "You are the forgettable agent of this test file." }], tools: agent }),
  ).toBeTrue();
  const [event] = await eventsOf(who.userId);
  const keys = [{ kind: "prompt" as const, rule: "Forgettable agent" }];
  expect(await learnedFingerprints(sql, keys)).toContain(event!.toolset_fingerprint!);

  const withoutRule = createAbuseScreen(parseAbuseRules(fixture));
  expect(await refused(withoutRule, who, { messages: [{ role: "user", content: "hi" }], tools: agent })).toBeFalse();
});

test("shadow matches never teach a fingerprint", async () => {
  const who = await principal();
  const agent = tools("shadowed");
  await screenRequest(sql, who, { ...request({ messages: [], tools: agent }, { "x-title": "Shadow-Test-App" }) });
  const [event] = await eventsOf(who.userId);
  expect(event).toMatchObject({ kind: "app", enforced: false });
  expect(await refused(createAbuseScreen(abuseRules), who, { messages: [], tools: agent })).toBeFalse();
});

test("matches are kept for 90 days", async () => {
  const who = await principal();
  await sql`
    INSERT INTO abuse_events (occurred_at, user_id, endpoint, kind, rule, enforced)
    VALUES
      (now() - interval '91 days', ${who.userId}::uuid, '/x', 'app', 'old', true),
      (now() - interval '89 days', ${who.userId}::uuid, '/x', 'app', 'recent', true)
  `;
  expect(await pruneAbuseEvents(sql)).toBeGreaterThanOrEqual(1);
  expect((await eventsOf(who.userId)).map((event) => event.rule)).toEqual(["recent"]);
});
