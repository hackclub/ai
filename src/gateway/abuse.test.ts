import { expect, test } from "bun:test";

import fixture from "../test/abuse-rules.json";
import {
  agentSurface,
  assertNotBlockedClient,
  BLOCKED_MESSAGE,
  createAbuseFilter,
  loadAbuseRules,
  matchToolset,
  NO_RULES,
  normalizeText,
  parseAbuseRules,
} from "./abuse";

const [prompt, multiline] = fixture.prompts["Test agent"] as [string, string];
const [emDash] = fixture.prompts["Test agent, escaped by Python"] as [string];
const agentTools = fixture.toolsets[0]!.tools;

const blocked = (body: unknown, headers: Record<string, string> = {}) => {
  try {
    assertNotBlockedClient(new Headers(headers), typeof body === "string" ? body : JSON.stringify(body));
    return false;
  } catch (error) {
    expect((error as Error).message).toBe(BLOCKED_MESSAGE);
    return true;
  }
};
const chat = (system: string, tools: string[] = []) => ({
  model: "m",
  messages: [{ role: "system", content: system }, { role: "user", content: "hi" }],
  tools: tools.map((name) => ({ type: "function", function: { name, description: `the ${name} tool`, parameters: {} } })),
});

test("the suite runs with the fixture rules, whether or not the secrets submodule is checked out", async () => {
  expect(await loadAbuseRules("src/test/abuse-rules.json")).toEqual(parseAbuseRules(fixture));
});

test("blocks apps by attribution headers and agents by User-Agent", () => {
  expect(blocked(null, { "x-title": "Blocked-Test-App" })).toBeTrue();
  expect(blocked(null, { referer: "https://blocked-test-app.example" })).toBeTrue();
  expect(blocked(null, { "user-agent": "Blocked-Test-Agent/1.0" })).toBeTrue();
  expect(blocked(chat("You are a friendly tutor."), { "user-agent": "python-requests/2.32" })).toBeFalse();
});

test("finds an agent's phrase wherever the agent writes its instructions", () => {
  expect(blocked(chat(`Context first. ${prompt} More after.`))).toBeTrue();
  expect(blocked({ system: [{ type: "text", text: "billing" }, { type: "text", text: prompt }], messages: [] })).toBeTrue();
  expect(blocked({ instructions: prompt, input: "hi" })).toBeTrue();
  expect(blocked({ input: [{ role: "developer", content: [{ type: "input_text", text: prompt }] }, { role: "user", content: "hi" }] })).toBeTrue();
  expect(blocked({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x", description: prompt } }] })).toBeTrue();
  expect(blocked({ version: "abc", input: { prompt: "a cat", system_prompt: prompt } })).toBeTrue();
});

test("ignores the phrase in what the user writes", () => {
  const quoted = { messages: [{ role: "system", content: "You are a tutor." }, { role: "user", content: `What does "${prompt}" mean?` }] };
  expect(blocked(quoted)).toBeFalse();
  expect(blocked({ version: "abc", input: { prompt } })).toBeFalse();
});

test("case, punctuation, line breaks and escaping do not change a match", () => {
  expect(blocked(chat(prompt.toUpperCase().replaceAll(",", " ,  ")))).toBeTrue();
  expect(blocked(chat(multiline.replaceAll("\n", "\n\n   ").replaceAll('"', "“")))).toBeTrue();
  const python = JSON.stringify(chat(emDash)).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  expect(python).toContain("\\u2014");
  expect(blocked(python)).toBeTrue();
  expect(blocked(chat(emDash.replace("—", "-")))).toBeTrue();
});

test("matches whole words, so a phrase inside a longer word does not count", () => {
  expect(blocked(chat(`Con${prompt.charAt(0).toLowerCase()}${prompt.slice(1)}`))).toBeFalse();
  expect(normalizeText("Don’t—stop!\n\nOK")).toBe(" don t stop ok ");
});

test("reads a system prompt however much conversation follows it", () => {
  const history = Array.from({ length: 2_000 }, () => ({ role: "user", content: "x".repeat(1_000) }));
  expect(blocked({ messages: [{ role: "system", content: prompt }, ...history] })).toBeTrue();
  expect(blocked({ messages: history, tools: agentTools.map((name) => ({ name })) })).toBeTrue();
});

test("fingerprints the tools a request defines, not the calls in its history", () => {
  expect(blocked(chat("You are a helpful assistant.", agentTools), { "user-agent": "Mozilla/5.0" })).toBeTrue();
  expect(blocked({ input: "hi", tools: agentTools.map((name) => ({ type: "function", name })) })).toBeTrue();
  expect(blocked(chat("hello", [...agentTools.slice(0, 3), "search_docs"]))).toBeFalse();
  const history = agentTools.map((name, i) => ({ role: "assistant", tool_calls: [{ id: `${i}`, type: "function", function: { name, arguments: "{}" } }] }));
  expect(blocked({ messages: history, tools: [{ type: "function", function: { name: "lookup" } }] })).toBeFalse();
  const toolset = { name: "t", tools: ["a", "b", "c"], minMatches: 2 };
  expect(matchToolset(new Set(["a"]), [toolset])).toBeNull();
  expect(matchToolset(new Set(["a", "c", "z"]), [toolset])?.name).toBe("t");
});

test("agentSurface reads each API's shape and nothing else", () => {
  expect(agentSurface(null)).toEqual({ instructions: [], tools: [] });
  expect(agentSurface({ system: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "n" }] })).toEqual({
    instructions: ["s"],
    tools: [{ name: "n", description: "" }],
  });
});

test("a body that is not JSON is left for the route to refuse", () => {
  expect(blocked(`not json ${prompt}`)).toBeFalse();
});

test("a checkout without the rules file runs with no rules", async () => {
  expect(await loadAbuseRules("secrets/does-not-exist.json")).toBeNull();
  const open = createAbuseFilter(NO_RULES);
  expect(() => open(new Headers({ "user-agent": "Blocked-Test-Agent" }), JSON.stringify(chat(prompt, agentTools)))).not.toThrow();
});

test("a malformed rules file is refused rather than read as no rules", () => {
  expect(parseAbuseRules({ prompts: { a: ["x"] } })).toEqual({ ...NO_RULES, prompts: { a: ["x"] } });
  expect(() => parseAbuseRules(null)).toThrow();
  expect(() => parseAbuseRules({ userAgents: "blocked-test-agent" })).toThrow("userAgents");
  expect(() => parseAbuseRules({ prompts: ["x"] })).toThrow("prompts");
  expect(() => parseAbuseRules({ prompts: { a: ["!!!"] } })).toThrow("no words");
  expect(() => parseAbuseRules({ toolsets: [{ name: "t", tools: ["a"], minMatches: 2 }] })).toThrow("toolset");
});
