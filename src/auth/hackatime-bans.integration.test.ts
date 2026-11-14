import { expect, test } from "bun:test";

import { keysApiRoutes } from "../gateway/keys-api";
import { fakeFetch } from "../gateway/routes/test-harness";
import { testDatabase } from "../test/database";
import { authenticateApiKey, issueApiKey } from "./api-keys";
import { syncHackatimeBans } from "./hackatime-bans";
import { createSessions } from "./sessions";
import { BANNED_MESSAGE, createUser } from "./users";

const { sql } = await testDatabase();
const sessions = createSessions({ sql, secureCookies: false });
const app = keysApiRoutes({ sql, baseUrl: "http://gateway.test", sessions });
const config = { baseUrl: "https://hackatime.test", adminApiKey: "hka_admin" };

type Banned = { id: number; username: string | null; slack_uid: string | null; email: string };

/** Hackatime's banned_users endpoint, paginated the way Rails does it. */
const hackatime = (banned: Banned[]) =>
  fakeFetch((url) => {
    const params = new URL(url).searchParams;
    const offset = Number(params.get("offset"));
    return Response.json({ banned_users: banned.slice(offset, offset + Number(params.get("limit"))) });
  });

const signUp = async (slackId: string, email: string | null = null) => {
  const user = await createUser(sql, { slackId, email, dailyAllowanceUsd: "1" });
  const key = await issueApiKey(sql, user.userId, "test");
  const cookie = (await sessions.start(user.userId)).split(";")[0] ?? "";
  return { ...user, authorization: `Bearer ${key.key}`, cookie };
};

const access = async (user: Awaited<ReturnType<typeof signUp>>) => {
  const key = await authenticateApiKey(sql, user.authorization, { enforceIdv: false }).then(
    () => "allowed",
    (error: Error) => error.message,
  );
  const page = await app.handle(new Request("http://gateway.test/api/keys", { headers: { cookie: user.cookie } }));
  return { key, dashboard: page.status };
};

const bannedAt = async (userId: string) => {
  const [row] = await sql<{ hackatime_banned_at: Date | null }[]>`
    SELECT hackatime_banned_at FROM users WHERE id = ${userId}::uuid
  `;
  return row!.hackatime_banned_at;
};

test("a Hackatime ban by Slack id or email locks the user out until Hackatime lifts it", async () => {
  const bySlack = await signUp("U-HT-SLACK");
  const byEmail = await signUp("U-HT-EMAIL", "Banned@Example.com");
  const bystander = await signUp("U-HT-FINE", "fine@example.com");
  const filler = Array.from({ length: 1500 }, (_, index) => ({
    id: index + 100,
    username: null,
    slack_uid: `U-FILLER-${index}`,
    email: "no email",
  }));
  const banned = [
    ...filler,
    { id: 1, username: "a", slack_uid: "U-HT-SLACK", email: "no email" },
    { id: 2, username: "b", slack_uid: null, email: "banned@example.com" },
  ];

  const first = hackatime(banned);
  expect(await syncHackatimeBans(sql, config, first.fetch)).toEqual({ banned: 2, unbanned: 0 });
  expect(first.upstream.map((call) => new URL(call.url).searchParams.get("offset"))).toEqual(["0", "1000"]);
  expect(first.upstream[0]!.headers.get("authorization")).toBe("Bearer hka_admin");

  expect(await access(bySlack)).toEqual({ key: BANNED_MESSAGE, dashboard: 403 });
  expect(await access(byEmail)).toEqual({ key: BANNED_MESSAGE, dashboard: 403 });
  expect(await access(bystander)).toEqual({ key: "allowed", dashboard: 200 });

  // A repeat sync keeps the original ban time.
  const since = await bannedAt(bySlack.userId);
  expect(await syncHackatimeBans(sql, config, hackatime(banned).fetch)).toEqual({ banned: 0, unbanned: 0 });
  expect(await bannedAt(bySlack.userId)).toEqual(since);

  expect(await syncHackatimeBans(sql, config, hackatime(banned.slice(0, -1)).fetch)).toEqual({ banned: 0, unbanned: 1 });
  expect(await bannedAt(byEmail.userId)).toBeNull();
  expect(await access(byEmail)).toEqual({ key: "allowed", dashboard: 200 });
  expect(await access(bySlack)).toEqual({ key: BANNED_MESSAGE, dashboard: 403 });
});

test("a Hackatime outage or a failed page lifts no ban", async () => {
  const user = await signUp("U-HT-OUTAGE");
  await syncHackatimeBans(sql, config, hackatime([{ id: 1, username: null, slack_uid: "U-HT-OUTAGE", email: "no email" }]).fetch);

  const down = fakeFetch(() => new Response("bad gateway", { status: 502 }));
  await expect(syncHackatimeBans(sql, config, down.fetch)).rejects.toThrow("502");
  // The first page succeeds and the second fails: a partial list must not count.
  const partial = fakeFetch((url) =>
    new URL(url).searchParams.get("offset") === "0"
      ? Response.json({ banned_users: Array.from({ length: 1000 }, (_, id) => ({ id, slack_uid: `U-X-${id}`, email: "no email" })) })
      : new Response(null, { status: 500 }),
  );
  await expect(syncHackatimeBans(sql, config, partial.fetch)).rejects.toThrow("500");
  const malformed = fakeFetch(() => Response.json({ error: "lmao no perms" }));
  await expect(syncHackatimeBans(sql, config, malformed.fetch)).rejects.toThrow("no list");

  expect(await bannedAt(user.userId)).not.toBeNull();
  expect(await access(user)).toEqual({ key: BANNED_MESSAGE, dashboard: 403 });
});

test("an HCAI admin ban survives Hackatime lifting its own", async () => {
  const user = await signUp("U-HT-BOTH");
  await sql`UPDATE users SET is_banned = true WHERE id = ${user.userId}::uuid`;
  await syncHackatimeBans(sql, config, hackatime([{ id: 1, username: null, slack_uid: "U-HT-BOTH", email: "no email" }]).fetch);
  await syncHackatimeBans(sql, config, hackatime([]).fetch);
  expect(await bannedAt(user.userId)).toBeNull();
  expect(await access(user)).toEqual({ key: BANNED_MESSAGE, dashboard: 403 });
});
