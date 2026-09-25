import type postgres from "postgres";

import type { AuthenticatedPrincipal } from "../auth/api-keys";
import { memoAsync } from "../cache/memo-async";
import { log } from "../log";
import { type AbuseRules, abuseRules, BLOCKED_MESSAGE, createAbuseFilter, enforcedRuleKeys } from "./abuse";
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

  return async (sql: postgres.Sql, principal: AuthenticatedPrincipal, request: ScreenedRequest) => {
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
    if (!match) return;
    if (learnedMode !== "off" && match.enforced && fingerprint && teaches.has(`${match.kind}\0${match.rule}`)) {
      (await learnedSet(sql)).add(fingerprint);
    }
    await recordAbuseEvent(sql, {
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
    if (match.enforced) throw new HttpError(403, BLOCKED_MESSAGE);
  };
};

export const screenRequest = createAbuseScreen(abuseRules);
