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
  /**
   * Phrases an agent always sends in its own instructions or tool
   * descriptions, grouped by agent. Compared as words: case, punctuation,
   * line breaks and JSON escaping do not matter. User messages are never read.
   */
  prompts: Record<string, string[]>;
  /** A request offering at least `minMatches` of an agent's tools is that agent. */
  toolsets: Toolset[];
};

export const NO_RULES: AbuseRules = { apps: [], userAgents: [], prompts: {}, toolsets: [] };

export const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

/** Longest instruction or tool description read; an agent's identity is at its start. */
const TEXT_LIMIT = 256 * 1024;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** Text of a message `content`: a string, or the `text` of each part. */
const textOf = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    typeof part === "string" ? [part] : isRecord(part) && typeof part.text === "string" ? [part.text] : [],
  );
};

const INSTRUCTION_ROLES = new Set(["system", "developer"]);

export type AgentSurface = { instructions: string[]; tools: { name: string; description: string }[] };

/**
 * The parts of a request an agent writes, not its user: system and developer
 * messages (Chat Completions, Responses `input`), Anthropic's `system`,
 * Responses' `instructions`, Replicate's `input.system_prompt`, and the tools.
 */
export const agentSurface = (body: unknown): AgentSurface => {
  if (!isRecord(body)) return { instructions: [], tools: [] };
  const instructions = [...textOf(body.system), ...textOf(body.instructions)];
  for (const list of [body.messages, body.input]) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (isRecord(message) && INSTRUCTION_ROLES.has(message.role as string)) instructions.push(...textOf(message.content));
    }
  }
  if (isRecord(body.input)) instructions.push(...textOf(body.input.system_prompt));
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) => {
        if (!isRecord(tool)) return [];
        const definition = isRecord(tool.function) ? tool.function : tool;
        return typeof definition.name === "string"
          ? [{ name: definition.name, description: typeof definition.description === "string" ? definition.description : "" }]
          : [];
      })
    : [];
  return { instructions, tools };
};

/** Words only, padded so that a phrase matches whole words: " you are claude code ". */
export const normalizeText = (text: string) =>
  ` ${text.slice(0, TEXT_LIMIT).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The first agent whose tools the request offers, or null. */
export const matchToolset = (names: ReadonlySet<string>, toolsets: readonly Toolset[]): Toolset | null =>
  toolsets.find(
    (toolset) => toolset.tools.reduce((count, tool) => count + (names.has(tool) ? 1 : 0), 0) >= toolset.minMatches,
  ) ?? null;

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
  const blank = Object.values(prompts as Record<string, string[]>).flat().find((prompt) => normalizeText(prompt).trim() === "");
  if (blank !== undefined) throw new Error(`abuse rules: prompt ${JSON.stringify(blank)} has no words to match`);
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

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON: the route refuses it with 400, and there is no agent surface to read.
    return null;
  }
};

/** A check that throws 403 for a request from a blocked client. */
export const createAbuseFilter = (rules: AbuseRules) => {
  const apps = rules.apps.map((app) => app.toLowerCase());
  const agents = rules.userAgents.map((agent) => agent.toLowerCase());
  const phrases = [...new Set(Object.values(rules.prompts).flat().map(normalizeText))];

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
    const surface = agentSurface(parseJson(body));
    if (phrases.length > 0) {
      // Each piece is capped on its own, so a long system prompt cannot push tool descriptions out.
      const text = [...surface.instructions, ...surface.tools.map((tool) => tool.description)].map(normalizeText).join("");
      if (phrases.some((phrase) => text.includes(phrase))) throw new HttpError(403, BLOCKED_MESSAGE);
    }
    if (matchToolset(new Set(surface.tools.map((tool) => tool.name)), rules.toolsets)) {
      throw new HttpError(403, BLOCKED_MESSAGE);
    }
  };
};

const path = abuseRulesPath();
const rules = await loadAbuseRules(path);
if (!rules) log.warn({ path }, "no abuse rules found; requests are not screened for blocked clients");

export const assertNotBlockedClient = createAbuseFilter(rules ?? NO_RULES);
