import type { Sql } from "postgres";

/**
 * Every Replicate call goes out under one shared account token, so Replicate
 * cannot scope predictions or files to the proxy user who created them. The
 * proxy records ownership itself and checks it before any read, cancel or
 * delete by id.
 */

export type ReplicateResourceKind = "prediction" | "file";

export type ReplicateResourceRecord = {
  kind: ReplicateResourceKind;
  id: string;
  userId: string;
  apiKeyId?: string | null;
  model?: string | null;
};

export const recordReplicateResource = async (sql: Sql, record: ReplicateResourceRecord) => {
  await sql`
    INSERT INTO replicate_resources (kind, id, user_id, api_key_id, model)
    VALUES (
      ${record.kind},
      ${record.id},
      ${record.userId}::uuid,
      ${record.apiKeyId ?? null}::uuid,
      ${record.model ?? null}
    )
    ON CONFLICT (kind, id) DO NOTHING
  `;
};

export const ownsReplicateResource = async (
  sql: Sql,
  kind: ReplicateResourceKind,
  id: string,
  userId: string,
): Promise<boolean> => {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok FROM replicate_resources
    WHERE kind = ${kind} AND id = ${id} AND user_id = ${userId}::uuid
    LIMIT 1
  `;
  return row?.ok === true;
};
