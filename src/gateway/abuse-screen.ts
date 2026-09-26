import type postgres from "postgres";

import type { AuthenticatedPrincipal } from "../auth/api-keys";
import { memoAsync } from "../cache/memo-async";
import { log } from "../log";
import { type AbuseMatch, type AbuseRules, abuseRules, BLOCKED_MESSAGE, createAbuseFilter, enforcedRuleKeys, matchIp } from "./abuse";
import { learnedFingerprints, recordAbuseEvent } from "./abuse-events";
import { HttpError } from "./http-error";

export type ScreenedRequest = {
  headers: Headers;
  endpoint: string;
  ip: string;
  body: string | null;
  /** False when this request's headers were already screened. */
  screenHeaders?: boolean;
};

/**
 * Screens an authenticated request: records any match in `abuse_events` and
 * throws 403 when the match is enforced. It runs after authentication so that
 * every match is attributed to a user and probing the rules needs a key.
 *
 * A blocked IP instead bans the account and answers with the gateway's
 * ordinary 500, so the operator learns the account is gone but not what gave
 * it away.
 */
export const createAbuseScreen = (rules: AbuseRules) => {
  const inspect = createAbuseFilter(rules);
  const teaching = enforcedRuleKeys(rules);
  const teaches = new Set(teaching.map(({ kind, rule }) => `${kind}\0${rule}`));
  // Keyed by pool, so each test database has its own. Refreshed every minute;
  // a refusal on this replica is learned at once.
  const learned = memoAsync((sql: postgres.Sql) => learnedFingerprints(sql, teaching), {
    ttlMs: 60_000,
    maxEntries: 16,
  });

  const learnedSet = (sql: postgres.Sql) =>
    learned.get(sql).catch((error: unknown) => {
      log.error({ err: error }, "could not load learned toolset fingerprints");
      return new Set<string>();
    });
  const learnedMode = rules.detectors.learnedToolsets;

  const record = (sql: postgres.Sql, principal: AuthenticatedPrincipal, request: ScreenedRequest, match: AbuseMatch, fingerprint: string | null) =>
    recordAbuseEvent(sql, {
      ...match,
      userId: principal.userId,
      apiKeyId: principal.apiKeyId,
      endpoint: request.endpoint,
      fingerprint,
      ip: request.ip,
      userAgent: request.headers.get("user-agent") ?? "",
    }).catch((error: unknown) => {
      // A refusal stands without its record; a shadow match is only lost.
      log.error({ err: error, kind: match.kind, enforced: match.enforced }, "could not record abuse match");
    });

  return async (sql: postgres.Sql, principal: AuthenticatedPrincipal, request: ScreenedRequest) => {
    const blockedIp = matchIp(rules.ips, request.ip);
    if (blockedIp) {
      await sql`UPDATE users SET is_banned = true, updated_at = now() WHERE id = ${principal.userId}::uuid AND NOT is_banned`;
      await record(sql, principal, request, { kind: "ip", rule: blockedIp, enforced: true }, null);
      log.warn({ userId: principal.userId, rule: blockedIp }, "banned an account for its IP address");
      throw new HttpError(500, "Internal server error");
    }
    const verdict = inspect(request.screenHeaders === false ? null : request.headers, request.body);
    const { fingerprint } = verdict;
    let { match } = verdict;
    // Only a request with a fingerprint waits on the learned set, and only
    // when a learned match would outrank what the filter found.
    if (fingerprint && learnedMode !== "off" && !match?.enforced && (learnedMode === "enforce" || !match)) {
      if ((await learnedSet(sql)).has(fingerprint)) {
        match = { kind: "learned_toolset", rule: fingerprint, enforced: learnedMode === "enforce" };
      }
    }
    const shadowIp = match ? null : matchIp(rules.shadow.ips, request.ip);
    if (shadowIp) match = { kind: "ip", rule: shadowIp, enforced: false };
    if (!match) return;
    if (learnedMode !== "off" && match.enforced && fingerprint && teaches.has(`${match.kind}\0${match.rule}`)) {
      (await learnedSet(sql)).add(fingerprint);
    }
    await record(sql, principal, request, match, fingerprint);
    if (match.enforced) throw new HttpError(403, BLOCKED_MESSAGE);
  };
};

export const screenRequest = createAbuseScreen(abuseRules);
