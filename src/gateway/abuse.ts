import { blockedApps } from "../config/blocked-apps";
import { blockedPrompts } from "../config/blocked-prompts";
import { type BlockedToolset, blockedToolsets } from "../config/blocked-toolsets";
import { blockedUserAgents } from "../config/blocked-user-agents";
import { HttpError } from "./http-error";

const BLOCKED_APPS = blockedApps.map((app) => app.toLowerCase());
const BLOCKED_AGENTS = blockedUserAgents.map((agent) => agent.toLowerCase());

export const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

export const BODY_SCAN_LIMIT = 256 * 1024;
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unicodeEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
export const promptForms = (prompt: string) => {
  const json = JSON.stringify(prompt).slice(1, -1);
  return [...new Set([prompt, json, json.replace(/[^\x00-\x7f]/g, unicodeEscape)])];
};
const BLOCKED_PROMPTS =
  blockedPrompts.length > 0
    ? new RegExp(blockedPrompts.flatMap(promptForms).map(escapeRegExp).join("|"))
    : null;

const NAME_FIELD = /"name"\s*:\s*"([A-Za-z0-9_.:-]{1,64})"/g;
export const toolNames = (body: string): Set<string> =>
  new Set(Array.from(body.matchAll(NAME_FIELD), (match) => match[1] as string));

/** The first blocked agent whose tools the request offers, or null. */
export const matchToolset = (
  names: ReadonlySet<string>,
  toolsets: readonly BlockedToolset[] = blockedToolsets,
): BlockedToolset | null =>
  toolsets.find(
    (toolset) => toolset.tools.reduce((count, tool) => count + (names.has(tool) ? 1 : 0), 0) >= toolset.minMatches,
  ) ?? null;

export const assertNotBlockedClient = (headers: Headers, body: string | null) => {
  const referer = (
    headers.get("referer") ??
    headers.get("http-referer") ??
    ""
  ).toLowerCase();
  const title = (headers.get("x-title") ?? "").toLowerCase();
  const userAgent = (headers.get("user-agent") ?? "").toLowerCase();

  if (BLOCKED_APPS.some((app) => referer.includes(app) || title.includes(app))) {
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
  if (BLOCKED_AGENTS.some((agent) => userAgent.includes(agent))) {
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
  if (!body) return;
  if (BLOCKED_PROMPTS?.test(body.length > BODY_SCAN_LIMIT ? body.slice(0, BODY_SCAN_LIMIT) : body)) {
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
  if (matchToolset(toolNames(body))) {
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
};
