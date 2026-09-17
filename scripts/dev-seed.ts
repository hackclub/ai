/**
 * Creates (or reuses) a local development user with a $3/day allowance, issues
 * an API key, and opens a 30-day browser session so the dashboard can be used
 * without Hack Club sign-in. Development only.
 *
 *   bun run dev:seed
 */
import postgres from "postgres";

import { createSession, SESSION_COOKIE } from "../src/auth/sessions";
import { createUser, issueApiKey } from "../src/auth/users";
import { loadEnv } from "../src/env";

const env = loadEnv();
if (env.nodeEnv === "production") {
  throw new Error("Refusing to seed a production environment");
}

const sql = postgres(env.databaseUrl, { max: 2 });
const slackId = "U-LOCAL-DEV";

let [user] = await sql<{ id: string }[]>`
  SELECT id FROM users WHERE slack_id = ${slackId}
`;
if (!user) {
  const created = await createUser(sql, {
    slackId,
    name: "Local Dev",
    email: "dev@localhost",
    dailyAllowanceUsd: "3",
  });
  await sql`UPDATE users SET is_idv_verified = true WHERE id = ${created.userId}::uuid`;
  user = { id: created.userId };
  console.log("Created user Local Dev");
} else {
  console.log("Reusing existing Local Dev user");
}

const key = await issueApiKey(sql, user.id, `dev ${new Date().toISOString().slice(0, 16)}`);
const session = await createSession(sql, user.id);
await sql.end();

console.log(`
API key (shown once):
  ${key.key}

Try it:
  curl ${env.baseUrl}/proxy/v1/chat/completions \\
    -H "Authorization: Bearer ${key.key}" \\
    -H "Content-Type: application/json" \\
    -d '{"model": "${env.allowedLanguageModels[0] ?? "openai/gpt-4o-mini"}", "messages": [{"role": "user", "content": "Hi"}]}'

Dashboard without sign-in: set this cookie for ${env.baseUrl} in your browser
(DevTools > Application > Cookies, or paste in the console):
  document.cookie = "${SESSION_COOKIE}=${session.token}; path=/; max-age=2592000"
then open ${env.baseUrl}/dashboard
`);
