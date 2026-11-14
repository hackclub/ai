import type postgres from "postgres";

import type { Fetch } from "../providers/openrouter/adapter";

export type HackatimeConfig = {
  baseUrl: string;
  /** A Hackatime Admin API key (viewer level is enough). */
  adminApiKey: string;
};

type BannedUser = { slack_uid?: string | null; email?: string | null };

const PAGE_SIZE = 1000;
/** Far above Hackatime's real ban count; stops a misbehaving API from looping forever. */
const MAX_PAGES = 200;
const TIMEOUT_MS = 30_000;

/**
 * Every Slack id and email of a user Hackatime has banned (red trust level).
 * Throws on any failure: a partial list would lift real bans.
 */
export async function fetchHackatimeBans(config: HackatimeConfig, fetch: Fetch = globalThis.fetch) {
  const slackIds = new Set<string>();
  const emails = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("/api/admin/v1/banned_users", config.baseUrl);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(page * PAGE_SIZE));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.adminApiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Hackatime banned_users returned ${response.status}`);
    const body = (await response.json()) as { banned_users?: unknown };
    if (!Array.isArray(body.banned_users)) throw new Error("Hackatime banned_users returned no list");
    const users = body.banned_users as BannedUser[];
    for (const user of users) {
      if (user.slack_uid) slackIds.add(user.slack_uid);
      if (user.email?.includes("@")) emails.add(user.email.toLowerCase());
    }
    if (users.length < PAGE_SIZE) return { slackIds: [...slackIds], emails: [...emails] };
  }
  throw new Error(`Hackatime banned_users has more than ${MAX_PAGES} pages`);
}

/**
 * Marks HCAI users whose Slack id or email Hackatime has banned, and clears
 * the mark once Hackatime lifts the ban.
 */
export async function syncHackatimeBans(sql: postgres.Sql, config: HackatimeConfig, fetch?: Fetch) {
  const { slackIds, emails } = await fetchHackatimeBans(config, fetch);
  const [counts] = await sql<{ banned: number; unbanned: number }[]>`
    WITH flagged AS (
      SELECT id FROM users WHERE slack_id = ANY(${slackIds}::text[]) OR lower(email) = ANY(${emails}::text[])
    ), changed AS (
      UPDATE users
      SET hackatime_banned_at = CASE WHEN hackatime_banned_at IS NULL THEN now() END, updated_at = now()
      WHERE (hackatime_banned_at IS NULL) = (id IN (SELECT id FROM flagged))
      RETURNING hackatime_banned_at IS NOT NULL AS banned
    )
    SELECT count(*) FILTER (WHERE banned)::int AS banned, count(*) FILTER (WHERE NOT banned)::int AS unbanned
    FROM changed
  `;
  return counts!;
}
