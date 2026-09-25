import type postgres from "postgres";

import type { AbuseMatch, AbuseMatchKind } from "./abuse";

/** How long matches are kept, and so how long a learned fingerprint lasts. */
export const ABUSE_EVENT_RETENTION_DAYS = 90;

export type AbuseEvent = AbuseMatch & {
  userId: string;
  apiKeyId: string | null;
  endpoint: string;
  fingerprint: string | null;
  ip: string;
  userAgent: string;
};

export const recordAbuseEvent = async (sql: postgres.Sql, event: AbuseEvent) => {
  await sql`
    INSERT INTO abuse_events (
      user_id, api_key_id, endpoint, kind, rule, enforced, toolset_fingerprint, ip, user_agent
    ) VALUES (
      ${event.userId}::uuid, ${event.apiKeyId}::uuid, ${event.endpoint}, ${event.kind}, ${event.rule},
      ${event.enforced}, ${event.fingerprint}, ${event.ip.slice(0, 64)}, ${event.userAgent.slice(0, 512)}
    )
  `;
};

export const learnedFingerprints = async (
  sql: postgres.Sql,
  rules: readonly { kind: AbuseMatchKind; rule: string }[],
): Promise<Set<string>> => {
  if (rules.length === 0) return new Set();
  const rows = await sql<{ fingerprint: string }[]>`
    SELECT DISTINCT toolset_fingerprint AS fingerprint
    FROM abuse_events
    WHERE
      enforced
      AND toolset_fingerprint IS NOT NULL
      AND (kind, rule) IN (
        SELECT * FROM unnest(${rules.map((r) => r.kind)}::text[], ${rules.map((r) => r.rule)}::text[])
      )
  `;
  return new Set(rows.map((row) => row.fingerprint));
};

export const pruneAbuseEvents = async (sql: postgres.Sql) => {
  const result = await sql`
    DELETE FROM abuse_events
    WHERE occurred_at < now() - make_interval(days => ${ABUSE_EVENT_RETENTION_DAYS})
  `;
  return result.count;
};
