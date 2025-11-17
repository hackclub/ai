import { db } from "../src/db";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function checkIdvStatus(
  slackId: string,
  email: string,
): Promise<boolean> {
  try {
    const urlBySlackId = new URL(
      "https://identity.hackclub.com/api/external/check",
    );
    urlBySlackId.searchParams.append("slack_id", slackId);

    const slackResponse = await fetch(urlBySlackId);
    if (slackResponse.ok) {
      const data = await slackResponse.json();
      if (data.result === "verified_eligible") {
        return true;
      }
    }

    if (!email) return false;

    const urlByEmail = new URL(
      "https://identity.hackclub.com/api/external/check",
    );
    urlByEmail.searchParams.append("email", email);

    const emailResponse = await fetch(urlByEmail);
    if (!emailResponse.ok) return false;

    const data = await emailResponse.json();
    return data.result === "verified_eligible";
  } catch (error) {
    console.error("IDV check error:", error);
    return false;
  }
}

async function importIdvStatus() {
  console.log("Starting IDV status import for all users...");

  const allUsers = await db.select().from(users);

  console.log(`Found ${allUsers.length} users`);

  const results = await Promise.all(
    allUsers.map(async (user) => {
      console.log(
        `Checking user: ${user.name || user.slackId} (${user.email || "no email"})`,
      );

      const isIdvVerified = await checkIdvStatus(
        user.slackId,
        user.email || "",
      );

      return { user, isIdvVerified };
    }),
  );

  let updatedCount = 0;
  let verifiedCount = 0;

  await Promise.all(
    results.map(async ({ user, isIdvVerified }) => {
      if (isIdvVerified !== user.isIdvVerified) {
        await db
          .update(users)
          .set({ isIdvVerified })
          .where(eq(users.id, user.id));

        updatedCount++;
        if (isIdvVerified) {
          console.log(`✓ ${user.name || user.slackId}: Verified and updated`);
          verifiedCount++;
        } else {
          console.log(`✗ ${user.name || user.slackId}: Not verified`);
        }
      } else {
        if (isIdvVerified) {
          console.log(`✓ ${user.name || user.slackId}: Already verified`);
          verifiedCount++;
        } else {
          console.log(`✗ ${user.name || user.slackId}: Not verified`);
        }
      }
    }),
  );

  console.log(`\nImport complete!`);
  console.log(`Total users: ${allUsers.length}`);
  console.log(`Updated: ${updatedCount}`);
  console.log(`Verified: ${verifiedCount}`);

  process.exit(0);
}

importIdvStatus().catch((error) => {
  console.error("Error importing IDV status:", error);
  process.exit(1);
});
