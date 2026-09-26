import { expect, test } from "bun:test";

import fixture from "../test/abuse-rules.json";
import {
  type AbuseRules,
  abuseRules,
  createAbuseFilter,
  enforcedRuleKeys,
  loadAbuseRules,
  matchToolset,
  NO_RULES,
  normalizeText,
  parseAbuseRules,
  toolsetFingerprint,
} from "./abuse";

const [prompt, multiline] = fixture.prompts["Test agent"] as [string, string];
const [emDash] = fixture.prompts["Test agent, escaped by Python"] as [string];
const agentTools = fixture.toolsets[0]!.tools;

const inspect = createAbuseFilter(abuseRules);
const verdict = (body: unknown, headers: Record<string, string> = {}, rules: AbuseRules = abuseRules) =>
  (rules === abuseRules ? inspect : createAbuseFilter(rules))(
    new Headers(headers),
    typeof body === "string" ? body : JSON.stringify(body),
  );
const blocked = (body: unknown, headers: Record<string, string> = {}) => verdict(body, headers).match?.enforced === true;
const chat = (system: string, tools: string[] = []) => ({
  model: "m",
  messages: [{ role: "system", content: system }, { role: "user", content: "hi" }],
  tools: tools.map((name) => ({ type: "function", function: { name, description: `the ${name} tool`, parameters: {} } })),
});
/** Tools with parameters, so the request has a toolset fingerprint. */
const shapedTools = (names: string[]) =>
  names.map((name, i) => ({
    type: "function",
    function: { name, parameters: { type: "object", properties: { [`arg_${i}`]: { type: "string" }, path: { type: "string" } } } },
  }));
const withDetectors = (detectors: Partial<AbuseRules["detectors"]>): AbuseRules => ({
  ...abuseRules,
  detectors: { ...abuseRules.detectors, ...detectors },
});

test("blocks apps by attribution headers and agents by User-Agent, naming the rule", () => {
  expect(verdict(null, { "x-title": "Blocked-Test-App" }).match).toEqual({ kind: "app", rule: "blocked-test-app", enforced: true });
  expect(blocked(null, { referer: "https://blocked-test-app.example" })).toBeTrue();
  expect(verdict(null, { "user-agent": "Blocked-Test-Agent/1.0" }).match).toEqual({
    kind: "user_agent",
    rule: "blocked-test-agent",
    enforced: true,
  });
  expect(verdict(chat("You are a friendly tutor."), { "user-agent": "python-requests/2.32" }).match).toBeNull();
});

test("shadow rules record a match without refusing, and an enforced rule wins over them", () => {
  expect(verdict(null, { "x-title": "Shadow-Test-App" }).match).toEqual({ kind: "app", rule: "shadow-test-app", enforced: false });
  expect(verdict(chat(prompt), { "x-title": "Shadow-Test-App" }).match).toEqual({ kind: "prompt", rule: "Test agent", enforced: true });
});

test("headers can be left out when they were already screened", () => {
  expect(inspect(null, JSON.stringify(chat("hello"))).match).toBeNull();
  expect(inspect(null, JSON.stringify(chat(prompt))).match?.kind).toBe("prompt");
});

test("finds an agent's phrase wherever the agent writes its instructions", () => {
  expect(verdict(chat(`Context first. ${prompt} More after.`)).match).toEqual({ kind: "prompt", rule: "Test agent", enforced: true });
  expect(blocked({ system: [{ type: "text", text: "billing" }, { type: "text", text: prompt }], messages: [] })).toBeTrue();
  expect(blocked({ instructions: prompt, input: "hi" })).toBeTrue();
  expect(blocked({ input: [{ role: "developer", content: [{ type: "input_text", text: prompt }] }, { role: "user", content: "hi" }] })).toBeTrue();
  expect(blocked({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x", description: prompt } }] })).toBeTrue();
  expect(blocked({ version: "abc", input: { prompt: "a cat", system_prompt: prompt } })).toBeTrue();
});

test("ignores the phrase in what the user writes when the request has instructions", () => {
  const quoted = { messages: [{ role: "system", content: "You are a tutor." }, { role: "user", content: `What does "${prompt}" mean?` }] };
  expect(verdict(quoted).match).toBeNull();
  expect(verdict({ version: "abc", input: { prompt } }).match).toBeNull();
});

test("reads the first user message of a request without instructions, in shadow unless enforced", () => {
  const moved = { messages: [{ role: "user", content: `${prompt}\n\nFix the bug.` }, { role: "user", content: "later" }] };
  expect(verdict(moved).match).toEqual({ kind: "user_prompt", rule: "Test agent", enforced: false });
  expect(verdict(moved, {}, withDetectors({ firstUserMessage: "enforce" })).match?.enforced).toBeTrue();
  expect(verdict(moved, {}, withDetectors({ firstUserMessage: "off" })).match).toBeNull();
  const later = { messages: [{ role: "user", content: "hi" }, { role: "user", content: prompt }] };
  expect(verdict(later).match).toBeNull();
});

test("case, punctuation, line breaks and escaping do not change a match", () => {
  expect(blocked(chat(prompt.toUpperCase().replaceAll(",", " ,  ")))).toBeTrue();
  expect(blocked(chat(multiline.replaceAll("\n", "\n\n   ").replaceAll('"', "“")))).toBeTrue();
  const python = JSON.stringify(chat(emDash)).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  expect(python).toContain("\\u2014");
  expect(blocked(python)).toBeTrue();
  expect(blocked(chat(emDash.replace("—", "-")))).toBeTrue();
});

test("invisible characters, accents and look-alike letters do not hide a phrase", () => {
  expect(blocked(chat(prompt.replace("Agent", "Ag​ent").replace("blocked", "bl­ocked")))).toBeTrue();
  expect(blocked(chat(prompt.replaceAll(" ", "​")))).toBeTrue();
  expect(blocked(chat(prompt.replace("Test", "Tеst").replace("client", "сlient")))).toBeTrue(); // Cyrillic е, с
  expect(blocked(chat(prompt.replace("Agent", "Αgent")))).toBeTrue(); // Greek Α
  expect(blocked(chat(prompt.replace("suite", "suíte")))).toBeTrue();
  expect(blocked(chat(prompt.replace("Test", "𝐓𝐞𝐬𝐭")))).toBeTrue();
  expect(normalizeText("Сlaude​Code")).toBe(" claudecode ");
});

test("matches whole words, so a phrase inside a longer word does not count", () => {
  expect(blocked(chat(`Con${prompt.charAt(0).toLowerCase()}${prompt.slice(1)}`))).toBeFalse();
  expect(normalizeText("Don’t—stop!\n\nOK")).toBe(" don t stop ok ");
});

test("a reworded long prompt matches by similarity, in shadow unless enforced", () => {
  const reworded = prompt.replace("blocked", "banned");
  expect(verdict(chat(reworded)).match).toEqual({ kind: "similar_prompt", rule: "Test agent", enforced: false });
  expect(verdict(chat(reworded), {}, withDetectors({ similarPrompts: "enforce" })).match).toEqual({
    kind: "similar_prompt",
    rule: "Test agent",
    enforced: true,
  });
  // Two changed words are a different sentence.
  expect(verdict(chat(reworded.replace("test suite", "demo suite"))).match).toBeNull();
  // Short prompts only ever match exactly.
  expect(verdict(chat(emDash.replace("dash", "rule"))).match).toBeNull();
});

test("reads a system prompt however much conversation follows it", () => {
  const history = Array.from({ length: 2_000 }, () => ({ role: "user", content: "x".repeat(1_000) }));
  expect(blocked({ messages: [{ role: "system", content: prompt }, ...history] })).toBeTrue();
  expect(blocked({ messages: history, tools: agentTools.map((name) => ({ name })) })).toBeTrue();
});

test("fingerprints the tools a request defines, not the calls in its history", () => {
  expect(verdict(chat("You are a helpful assistant.", agentTools), { "user-agent": "Mozilla/5.0" }).match).toEqual({
    kind: "toolset",
    rule: "test-agent",
    enforced: true,
  });
  expect(blocked({ input: "hi", tools: agentTools.map((name) => ({ type: "function", name })) })).toBeTrue();
  expect(blocked(chat("hello", [...agentTools.slice(0, 3), "search_docs"]))).toBeFalse();
  const history = agentTools.map((name, i) => ({ role: "assistant", tool_calls: [{ id: `${i}`, type: "function", function: { name, arguments: "{}" } }] }));
  expect(blocked({ messages: history, tools: [{ type: "function", function: { name: "lookup" } }] })).toBeFalse();
  const toolset = { name: "t", tools: ["a", "b", "c"], minMatches: 2 };
  expect(matchToolset(new Set(["a"]), [toolset])).toBeNull();
  expect(matchToolset(new Set(["a", "c", "z"]), [toolset])?.name).toBe("t");
});

test("a toolset fingerprint survives renamed tools and changes with their parameters", () => {
  const names = ["one", "two", "three", "four", "five"];
  const original = verdict({ messages: [], tools: shapedTools(names) }).fingerprint;
  expect(original).toMatch(/^[0-9a-f]{32}$/);
  const renamed = verdict({ messages: [], tools: shapedTools(names.map((name) => `${name}_v2`).reverse()).reverse() }).fingerprint;
  expect(renamed).toBe(original);
  const anthropic = shapedTools(names).map(({ function: f }) => ({ name: f.name, input_schema: f.parameters }));
  expect(verdict({ messages: [], tools: anthropic }).fingerprint).toBe(original);
  expect(verdict({ messages: [], tools: shapedTools([...names, "six"]) }).fingerprint).not.toBe(original);
  const retyped = shapedTools(names).map((tool, i) => (i === 0 ? { ...tool, function: { ...tool.function, parameters: { type: "object", properties: { arg_0: { type: "integer" }, path: { type: "string" } } } } } : tool));
  expect(verdict({ messages: [], tools: retyped }).fingerprint).not.toBe(original);
  // Too few tools with parameters to tell one app from another.
  expect(verdict({ messages: [], tools: shapedTools(names.slice(0, 4)) }).fingerprint).toBeNull();
  expect(toolsetFingerprint(names.map((name) => ({ name, description: "", shape: "" })))).toBeNull();
});

test("a body that is not JSON is left for the route to refuse", () => {
  expect(blocked(`not json ${prompt}`)).toBeFalse();
});

test("a checkout without the rules file runs with no rules", async () => {
  expect(await loadAbuseRules("secrets/does-not-exist.json")).toBeNull();
  const open = createAbuseFilter(NO_RULES);
  expect(open(new Headers({ "user-agent": "Blocked-Test-Agent" }), JSON.stringify(chat(prompt, agentTools))).match).toBeNull();
});

test("refusals are attributed only to enforced rules and enforcing detectors", () => {
  const keys = enforcedRuleKeys(abuseRules);
  expect(keys).toContainEqual({ kind: "prompt", rule: "Test agent" });
  expect(keys).toContainEqual({ kind: "toolset", rule: "test-agent" });
  expect(keys).not.toContainEqual({ kind: "app", rule: "shadow-test-app" });
  expect(keys.some((key) => key.kind === "similar_prompt")).toBeFalse();
  expect(enforcedRuleKeys(withDetectors({ similarPrompts: "enforce" }))).toContainEqual({ kind: "similar_prompt", rule: "Test agent" });
});

test("a rules file gets its defaults filled in, and a prompt with no words matches nothing", () => {
  expect(parseAbuseRules({ prompts: { a: ["x"] } })).toEqual({
    ...NO_RULES,
    prompts: { a: ["x"] },
    detectors: { similarPrompts: "shadow", firstUserMessage: "shadow", learnedToolsets: "shadow" },
  });
  expect(parseAbuseRules({ detectors: { learnedToolsets: "enforce" } }).detectors.learnedToolsets).toBe("enforce");
  const blank = createAbuseFilter(parseAbuseRules({ prompts: { a: ["!!!"] } }));
  expect(blank(new Headers(), JSON.stringify(chat("anything", ["tool"]))).match).toBeNull();
});
