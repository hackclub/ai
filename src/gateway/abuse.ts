import { blockedApps } from "../config/blocked-apps";
import { blockedPrompts } from "../config/blocked-prompts";
import { blockedUserAgents } from "../config/blocked-user-agents";
import { HttpError } from "./http-error";

const BLOCKED_APPS = blockedApps.map((app) => app.toLowerCase());
const BLOCKED_AGENTS = blockedUserAgents.map((agent) => agent.toLowerCase());

export const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

export const BODY_SCAN_LIMIT = 256 * 1024;
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCKED_PROMPTS =
  blockedPrompts.length > 0 ? new RegExp(blockedPrompts.map(escapeRegExp).join("|")) : null;

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
  if (
    body &&
    BLOCKED_PROMPTS &&
    BLOCKED_PROMPTS.test(body.length > BODY_SCAN_LIMIT ? body.slice(0, BODY_SCAN_LIMIT) : body)
  ) {
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
};
