import { abuseRulesPath } from "../env";
import { log } from "../log";
import { HttpError } from "./http-error";

export type Toolset = { name: string; tools: string[]; minMatches: number };

/**
 * What to refuse. The real rules live in the private `secrets` submodule so
 * they are not published; checkouts without it run with none.
 */
export type AbuseRules = {
  /** Matched against the Referer and X-Title headers. */
  apps: string[];
  userAgents: string[];
  /** Prompt fragments, grouped by the agent they come from. */
  prompts: Record<string, string[]>;
  /** A request offering at least `minMatches` of an agent's tools is that agent. */
  toolsets: Toolset[];
};

export const NO_RULES: AbuseRules = { apps: [], userAgents: [], prompts: {}, toolsets: [] };

export const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

export const BODY_SCAN_LIMIT = 256 * 1024;
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unicodeEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
export const promptForms = (prompt: string) => {
  const json = JSON.stringify(prompt).slice(1, -1);
  return [...new Set([prompt, json, json.replace(/[^\x00-\x7f]/g, unicodeEscape)])];
};

const NAME_FIELD = /"name"\s*:\s*"([A-Za-z0-9_.:-]{1,64})"/g;
export const toolNames = (body: string): Set<string> =>
  new Set(Array.from(body.matchAll(NAME_FIELD), (match) => match[1] as string));

/** The first agent whose tools the request offers, or null. */
export const matchToolset = (names: ReadonlySet<string>, toolsets: readonly Toolset[]): Toolset | null =>
  toolsets.find(
    (toolset) => toolset.tools.reduce((count, tool) => count + (names.has(tool) ? 1 : 0), 0) >= toolset.minMatches,
  ) ?? null;

/** The head and tail of the body: system prompts sit at the start, tool definitions at the end. */
const scanWindows = (body: string) =>
  body.length > 2 * BODY_SCAN_LIMIT ? [body.slice(0, BODY_SCAN_LIMIT), body.slice(-BODY_SCAN_LIMIT)] : [body];

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

/** Validates a rules file. Throws on a malformed one: a typo must not switch the blocklist off. */
export const parseAbuseRules = (value: unknown): AbuseRules => {
  const rules = value as Partial<Record<keyof AbuseRules, unknown>> | null;
  if (!rules || typeof rules !== "object") throw new Error("abuse rules must be an object");
  const { apps = [], userAgents = [], prompts = {}, toolsets = [] } = rules;
  if (!isStrings(apps)) throw new Error("abuse rules: apps must be a list of strings");
  if (!isStrings(userAgents)) throw new Error("abuse rules: userAgents must be a list of strings");
  if (!prompts || typeof prompts !== "object" || !Object.values(prompts).every(isStrings)) {
    throw new Error("abuse rules: prompts must map agent names to lists of strings");
  }
  if (
    !Array.isArray(toolsets) ||
    !toolsets.every(
      (toolset) =>
        typeof toolset?.name === "string" &&
        isStrings(toolset.tools) &&
        Number.isInteger(toolset.minMatches) &&
        toolset.minMatches > 0 &&
        toolset.minMatches <= toolset.tools.length,
    )
  ) {
    throw new Error("abuse rules: each toolset needs a name, tools and 0 < minMatches <= tools.length");
  }
  return { apps, userAgents, prompts: prompts as Record<string, string[]>, toolsets: toolsets as Toolset[] };
};

/** The rules at `path`, or null when there is no file there. */
export const loadAbuseRules = async (path: string): Promise<AbuseRules | null> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return parseAbuseRules(await file.json());
};

/** A check that throws 403 for a request from a blocked client. */
export const createAbuseFilter = (rules: AbuseRules) => {
  const apps = rules.apps.map((app) => app.toLowerCase());
  const agents = rules.userAgents.map((agent) => agent.toLowerCase());
  const fragments = Object.values(rules.prompts).flat();
  const prompts =
    fragments.length > 0 ? new RegExp(fragments.flatMap(promptForms).map(escapeRegExp).join("|")) : null;

  return (headers: Headers, body: string | null) => {
    const referer = (headers.get("referer") ?? headers.get("http-referer") ?? "").toLowerCase();
    const title = (headers.get("x-title") ?? "").toLowerCase();
    const userAgent = (headers.get("user-agent") ?? "").toLowerCase();

    if (apps.some((app) => referer.includes(app) || title.includes(app))) {
      throw new HttpError(403, BLOCKED_MESSAGE);
    }
    if (agents.some((agent) => userAgent.includes(agent))) {
      throw new HttpError(403, BLOCKED_MESSAGE);
    }
    if (!body) return;
    const windows = scanWindows(body);
    if (prompts && windows.some((window) => prompts.test(window))) {
      throw new HttpError(403, BLOCKED_MESSAGE);
    }
    if (rules.toolsets.length > 0 && matchToolset(new Set(windows.flatMap((window) => [...toolNames(window)])), rules.toolsets)) {
      throw new HttpError(403, BLOCKED_MESSAGE);
    }
  };
};

const path = abuseRulesPath();
const rules = await loadAbuseRules(path);
if (!rules) log.warn({ path }, "no abuse rules found; requests are not screened for blocked clients");

export const assertNotBlockedClient = createAbuseFilter(rules ?? NO_RULES);
