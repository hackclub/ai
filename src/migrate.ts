import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from './env';

export async function runMigrations() {
  console.log('Running database migrations...');

  // Create a connection specifically for migrations
  // For migrations, we need to disable prepared statements
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('✓ Migrations completed successfully');
  } catch (error) {
    console.error('✗ Migration failed:', error);
    throw error;
  } finally {
    await migrationClient.end();
  }
}
