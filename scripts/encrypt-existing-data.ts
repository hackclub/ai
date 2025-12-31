import sodium from "libsodium-wrappers";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const ENCRYPTION_PUBLIC_KEY = process.env.ENCRYPTION_PUBLIC_KEY;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

if (!ENCRYPTION_PUBLIC_KEY) {
  console.error("ENCRYPTION_PUBLIC_KEY is not set");
  process.exit(1);
}

await sodium.ready;

const publicKey = sodium.from_base64(ENCRYPTION_PUBLIC_KEY);

function encrypt(value: string): string {
  const encryptedData = sodium.crypto_box_seal(value, publicKey);
  return sodium.to_base64(encryptedData);
}

function isLikelyUnencrypted(value: string): boolean {
  if (!value) return false;

  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }

  return false;
}

const sql = postgres(DATABASE_URL);

console.log("Starting encryption migration...");

const BATCH_SIZE = 100;
let offset = 0;
let totalProcessed = 0;
let totalEncrypted = 0;

while (true) {
  const rows = await sql`
    SELECT id, request, response 
    FROM request_logs 
    ORDER BY id 
    LIMIT ${BATCH_SIZE} 
    OFFSET ${offset}
  `;

  if (rows.length === 0) {
    break;
  }

  const encryptionPromises = rows.map(async (row) => {
    const needsRequestEncryption = isLikelyUnencrypted(row.request);
    const needsResponseEncryption = isLikelyUnencrypted(row.response);

    if (needsRequestEncryption || needsResponseEncryption) {
      const updates: Record<string, string> = {};

      if (needsRequestEncryption) {
        updates.request = encrypt(row.request);
      }

      if (needsResponseEncryption) {
        updates.response = encrypt(row.response);
      }

      // Update the row
      if (needsRequestEncryption && needsResponseEncryption) {
        await sql`
          UPDATE request_logs 
          SET request = ${updates.request}, response = ${updates.response}
          WHERE id = ${row.id}
        `;
      } else if (needsRequestEncryption) {
        await sql`
          UPDATE request_logs 
          SET request = ${updates.request}
          WHERE id = ${row.id}
        `;
      } else if (needsResponseEncryption) {
        await sql`
          UPDATE request_logs 
          SET response = ${updates.response}
          WHERE id = ${row.id}
        `;
      }

      console.log(`Encrypted row ${row.id}`);
      return 1;
    }
    return 0;
  });

  const results = await Promise.all(encryptionPromises);
  totalEncrypted += (results as number[]).reduce((sum, val) => sum + val, 0);

  totalProcessed += rows.length;
  offset += BATCH_SIZE;
  console.log(`Processed ${totalProcessed} rows...`);
}

await sql.end();

console.log("\n--- Migration Complete ---");
console.log(`Total rows processed: ${totalProcessed}`);
console.log(`Total rows encrypted: ${totalEncrypted}`);
console.log(`Rows already encrypted: ${totalProcessed - totalEncrypted}`);
