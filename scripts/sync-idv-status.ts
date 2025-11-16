import { db } from '../src/db';
import { users } from '../src/db/schema';
import { checkIdvStatus } from '../src/utils/idv';
import { eq } from 'drizzle-orm';

async function syncIdvStatus() {
  console.log('Starting IDV status sync for all users...');

  const allUsers = await db.select().from(users);

  console.log(`Found ${allUsers.length} users to process`);

  let updated = 0;
  let verified = 0;

  for (const user of allUsers) {
    const isIdvVerified = await checkIdvStatus(user.slackId, user.email || undefined);

    if (isIdvVerified !== user.isIdvVerified) {
      await db
        .update(users)
        .set({
          isIdvVerified,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      updated++;
      console.log(`Updated user ${user.slackId}: ${isIdvVerified ? 'verified' : 'not verified'}`);
    }

    if (isIdvVerified) {
      verified++;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\nSync complete!`);
  console.log(`Total users: ${allUsers.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Verified: ${verified}`);
  console.log(`Not verified: ${allUsers.length - verified}`);

  process.exit(0);
}

syncIdvStatus().catch((error) => {
  console.error('Error syncing IDV status:', error);
  process.exit(1);
});
