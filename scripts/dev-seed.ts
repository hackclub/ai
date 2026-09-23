import postgres from "postgres";

import { issueApiKey } from "../src/auth/api-keys";
import { createSessions } from "../src/auth/sessions";
import { createUser } from "../src/auth/users";
import { loadEnv } from "../src/env";

const env = loadEnv();
if (env.nodeEnv === "production") {
  throw new Error("Refusing to seed a production environment");
}

const sql = postgres(env.databaseUrl, { max: 2 });
const slackId = "U059VC0UDEU";

let [user] = await sql<{ id: string }[]>`
  SELECT id FROM users WHERE slack_id = ${slackId}
`;
if (!user) {
  const created = await createUser(sql, {
    slackId,
    name: "Local Dev",
    email: "dev@localhost.com",
    dailyAllowanceUsd: "3",
  });
  await sql`UPDATE users SET is_idv_verified = true WHERE id = ${created.userId}::uuid`;
  user = { id: created.userId };
  console.log("Created user Local Dev");
} else {
  console.log("Reusing existing Local Dev user");
}

const key = await issueApiKey(sql, user.id, `dev ${new Date().toISOString().slice(0, 16)}`);
// Seeding is refused in production, so this matches what the dev server derives.
const setCookie = await createSessions({ sql, secureCookies: false }).start(user.id);
await sql.end();

console.log(`
API key (shown once):
  ${key.key}

Try it:
  curl ${env.baseUrl}/proxy/v1/chat/completions \\
    -H "Authorization: Bearer ${key.key}" \\
    -H "Content-Type: application/json" \\
    -d '{"model": "${env.featuredModels[0] ?? "openai/gpt-4o-mini"}", "messages": [{"role": "user", "content": "Hi"}]}'

Dashboard without sign-in: set this cookie for ${env.baseUrl} in your browser
(DevTools > Application > Cookies, or paste in the console):
  # Dev is never secure, so the cookie keeps the bare (non "__Host-") name.
  document.cookie = "${setCookie.split(";")[0]}; path=/; max-age=2592000"
then open ${env.baseUrl}/dashboard
`);
