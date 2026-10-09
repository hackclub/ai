import type postgres from "postgres";

export type AuditTarget = "user" | "funding_policy" | "limit_policy" | "discount";

/** Records an admin action, in the transaction that makes the change. */
export const recordAdminAction = (
  tx: postgres.TransactionSql,
  event: { actorUserId: string; action: string; targetType: AuditTarget; targetId: string; reason?: string | null; details?: object },
) => tx`
  INSERT INTO admin_audit_events (actor_user_id, action, target_type, target_id, reason, details)
  VALUES (
    ${event.actorUserId}::uuid,
    ${event.action},
    ${event.targetType},
    ${event.targetId},
    ${event.reason ?? null},
    ${tx.json(JSON.parse(JSON.stringify(event.details ?? {})) as postgres.JSONValue)}
  )
`;
