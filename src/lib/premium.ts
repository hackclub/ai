import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { premiumModelAccess } from "../db/schema";
import premiumModelsConfig from "../config/premium-models.json";

export type PremiumModelConfig = {
  modelId: string;
  displayName: string;
  requiredDonationCents: number;
  reason: string;
};

export function isPremiumModel(modelId: string): boolean {
  return premiumModelsConfig.models.some((m) => m.modelId === modelId);
}

export function getPremiumConfig(modelId: string): PremiumModelConfig | null {
  const config = premiumModelsConfig.models.find((m) => m.modelId === modelId);
  return config || null;
}

export function getAllPremiumModels(): PremiumModelConfig[] {
  return premiumModelsConfig.models;
}

export function getDonationUrl(): string {
  return premiumModelsConfig.donationUrl;
}

export function formatDonationAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function generateReferenceCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `HACKAI-${code}`;
}

export async function checkUserAccess(
  userId: string,
  modelId: string,
): Promise<boolean> {
  const [access] = await db
    .select()
    .from(premiumModelAccess)
    .where(
      and(
        eq(premiumModelAccess.userId, userId),
        eq(premiumModelAccess.modelId, modelId),
        or(
          isNull(premiumModelAccess.expiresAt),
          gt(premiumModelAccess.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);

  return !!access;
}

export async function getUserPremiumAccess(
  userId: string,
): Promise<Set<string>> {
  const accessList = await db
    .select({ modelId: premiumModelAccess.modelId })
    .from(premiumModelAccess)
    .where(
      and(
        eq(premiumModelAccess.userId, userId),
        or(
          isNull(premiumModelAccess.expiresAt),
          gt(premiumModelAccess.expiresAt, new Date()),
        ),
      ),
    );

  return new Set(accessList.map((a) => a.modelId));
}

export function getPremiumModelIds(): Set<string> {
  return new Set(premiumModelsConfig.models.map((m) => m.modelId));
}
