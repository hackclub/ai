import * as Sentry from "@sentry/bun";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { users } from "../db/schema";
import { env } from "../env";
import type { User } from "../types";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

type CreateKeyResponse = {
  data: { hash: string; name: string; limit: number | null };
  key: string;
};

const provisioningHeaders = () => ({
  Authorization: `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
  "Content-Type": "application/json",
});

async function createOpenrouterKey(user: User, limit: number) {
  const res = await fetch(`${OPENROUTER_BASE}/keys`, {
    method: "POST",
    headers: provisioningHeaders(),
    body: JSON.stringify({
      name: `hackclub-ai/${user.slackId}`,
      label: user.id,
      limit,
      limit_reset: "daily",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `OpenRouter create key failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as CreateKeyResponse;
}

async function updateOpenrouterKeyLimit(hash: string, limit: number) {
  const res = await fetch(`${OPENROUTER_BASE}/keys/${hash}`, {
    method: "PATCH",
    headers: provisioningHeaders(),
    body: JSON.stringify({ limit, limit_reset: "daily" }),
  });
  if (!res.ok) {
    throw new Error(
      `OpenRouter update key failed: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Ensure the user has an OpenRouter API key provisioned with the spending
 * limit synchronized to user.spendingLimitUsd. Mutates the passed-in user
 * object so callers see the latest values.
 */
export async function ensureOpenrouterKey(user: User): Promise<string> {
  return Sentry.startSpan({ name: "openrouter.ensureKey" }, async () => {
    const desiredLimit = parseFloat(user.spendingLimitUsd || "4");

    if (!user.openrouterKey || !user.openrouterKeyHash) {
      const created = await createOpenrouterKey(user, desiredLimit);
      const limitStr = String(desiredLimit);
      await db
        .update(users)
        .set({
          openrouterKey: created.key,
          openrouterKeyHash: created.data.hash,
          openrouterKeyLimit: limitStr,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      user.openrouterKey = created.key;
      user.openrouterKeyHash = created.data.hash;
      user.openrouterKeyLimit = limitStr;
      return created.key;
    }

    const syncedLimit =
      user.openrouterKeyLimit != null
        ? parseFloat(user.openrouterKeyLimit)
        : null;

    if (syncedLimit !== desiredLimit) {
      await updateOpenrouterKeyLimit(user.openrouterKeyHash, desiredLimit);
      const limitStr = String(desiredLimit);
      await db
        .update(users)
        .set({
          openrouterKeyLimit: limitStr,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      user.openrouterKeyLimit = limitStr;
    }

    return user.openrouterKey;
  });
}
