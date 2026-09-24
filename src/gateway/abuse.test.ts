import { expect, test } from "bun:test";

import fixture from "../test/abuse-rules.json";
import {
  assertNotBlockedClient,
  BLOCKED_MESSAGE,
  BODY_SCAN_LIMIT,
  createAbuseFilter,
  loadAbuseRules,
  matchToolset,
  NO_RULES,
  parseAbuseRules,
  promptForms,
  toolNames,
} from "./abuse";

const [prompt, multiline] = fixture.prompts["Test agent"];
const [emDash] = fixture.prompts["Test agent, escaped by Python"];
const agentTools = fixture.toolsets[0]!.tools;

const check = (headers: Record<string, string>, body: string | null = null) => () =>
  assertNotBlockedClient(new Headers(headers), body);

const chat = (system: string, tools: string[] = []) =>
  JSON.stringify({
    model: "m",
    messages: [{ role: "system", content: system }, { role: "user", content: "hi" }],
    tools: tools.map((name) => ({ type: "function", function: { name, parameters: {} } })),
  });

test("the suite runs with the fixture rules, whether or not the secrets submodule is checked out", async () => {
  expect(await loadAbuseRules("src/test/abuse-rules.json")).toEqual(parseAbuseRules(fixture));
});

test("blocks apps by attribution headers, agents by User-Agent, and prompts", () => {
  expect(check({ "x-title": "Blocked-Test-App" })).toThrow(BLOCKED_MESSAGE);
  expect(check({ referer: "https://blocked-test-app.example" })).toThrow(BLOCKED_MESSAGE);
  expect(check({ "user-agent": "Blocked-Test-Agent/1.0" })).toThrow(BLOCKED_MESSAGE);
  expect(check({}, chat(`prefix ${prompt} suffix`))).toThrow(BLOCKED_MESSAGE);
});

test("allows ordinary clients", () => {
  expect(check({ "user-agent": "python-requests/2.32", referer: "https://example.dev" }, chat("hello"))).not.toThrow();
});

test("matches prompts with newlines and quotes inside a JSON body, and as Python escapes them", () => {
  expect(check({}, chat(multiline!))).toThrow(BLOCKED_MESSAGE);
  const python = chat(emDash!).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  expect(python).toContain("\\u2014");
  expect(check({}, python)).toThrow(BLOCKED_MESSAGE);
  expect(promptForms('say "hi" — now')).toEqual(['say "hi" — now', 'say \\"hi\\" — now', 'say \\"hi\\" \\u2014 now']);
});

test("scans the first and last BODY_SCAN_LIMIT bytes of a large body", () => {
  const filler = "x".repeat(BODY_SCAN_LIMIT);
  expect(check({}, prompt + filler + filler)).toThrow(BLOCKED_MESSAGE);
  expect(check({}, filler + filler + prompt)).toThrow(BLOCKED_MESSAGE);
  expect(check({}, filler + prompt + filler)).not.toThrow();
  const tools = chat("hello", agentTools).slice(1);
  expect(check({}, `{"padding":"${filler}${filler}",${tools}`)).toThrow(BLOCKED_MESSAGE);
});

test("blocks an agent by the tools it offers, however it names itself", () => {
  expect(check({ "user-agent": "Mozilla/5.0" }, chat("You are a helpful assistant.", agentTools))).toThrow(BLOCKED_MESSAGE);
  const responses = JSON.stringify({ input: "hi", tools: agentTools.map((name) => ({ type: "function", name })) });
  expect(check({}, responses)).toThrow(BLOCKED_MESSAGE);
  expect(check({}, chat("hello", [...agentTools.slice(0, 3), "search_docs"]))).not.toThrow();
});

test("toolNames reads definitions and earlier tool calls, and matchToolset needs minMatches", () => {
  const body = JSON.stringify({
    messages: [{ role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name: "todo", arguments: "{}" } }] }],
    tools: [{ type: "function", function: { name: "read" } }, { name: "Bash", input_schema: {} }],
  });
  expect([...toolNames(body)].sort()).toEqual(["Bash", "read", "todo"]);
  const toolset = { name: "t", tools: ["a", "b", "c"], minMatches: 2 };
  expect(matchToolset(new Set(["a"]), [toolset])).toBeNull();
  expect(matchToolset(new Set(["a", "c", "z"]), [toolset])?.name).toBe("t");
});

test("a checkout without the rules file runs with no rules", async () => {
  expect(await loadAbuseRules("secrets/does-not-exist.json")).toBeNull();
  const open = createAbuseFilter(NO_RULES);
  expect(() => open(new Headers({ "user-agent": "Blocked-Test-Agent" }), chat(prompt!, agentTools))).not.toThrow();
});

test("a malformed rules file is refused rather than read as no rules", () => {
  expect(parseAbuseRules({ prompts: { a: ["x"] } })).toEqual({ ...NO_RULES, prompts: { a: ["x"] } });
  expect(() => parseAbuseRules(null)).toThrow();
  expect(() => parseAbuseRules({ userAgents: "blocked-test-agent" })).toThrow("userAgents");
  expect(() => parseAbuseRules({ prompts: ["x"] })).toThrow("prompts");
  expect(() => parseAbuseRules({ prompts: { a: [""] } })).toThrow("prompts");
  expect(() => parseAbuseRules({ toolsets: [{ name: "t", tools: ["a"], minMatches: 2 }] })).toThrow("toolset");
});
