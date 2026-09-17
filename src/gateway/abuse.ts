import { blockedApps } from "../config/blocked-apps";
import { blockedPrompts } from "../config/blocked-prompts";
import { blockedUserAgents } from "../config/blocked-user-agents";
import { HttpError } from "./http-error";

const BLOCKED_APPS = blockedApps.map((app) => app.toLowerCase());
const BLOCKED_AGENTS = blockedUserAgents.map((agent) => agent.toLowerCase());

export const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

/**
 * Rejects known coding agents and chat frontends by their attribution
 * headers, user agent, or well-known system prompt fragments in the body.
 * Ported unchanged from the previous gateway's policy.
 */
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
  if (body && blockedPrompts.some((prompt) => body.includes(prompt))) {
    throw new HttpError(403, BLOCKED_MESSAGE);
  }
};
