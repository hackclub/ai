import { expect, test } from "bun:test";

import { createSessions, type SessionUser } from "../../auth/sessions";
import { BANNED_MESSAGE, createUser } from "../../auth/users";
import { testDatabase } from "../../test/database";
import { requireUser } from "./page.ts";

const { sql } = await testDatabase();
const sessions = createSessions({ sql, secureCookies: false });

const signedIn = async (slackId: string, banned = false) => {
  const created = await createUser(sql, { slackId });
  if (banned) await sql`UPDATE users SET is_banned = true WHERE id = ${created.userId}::uuid`;
  const setCookie = await sessions.start(created.userId);
  return sessions.user(setCookie.split(";")[0] ?? null);
};

const thrownBy = (user: SessionUser | null) => {
  try {
    requireUser({ user });
  } catch (error) {
    return error as { status: number; location?: string; body?: { message: string } };
  }
  throw new Error("expected requireUser to throw");
};

test("redirects to / when there is no signed-in user", () => {
  expect(thrownBy(null)).toMatchObject({ status: 302, location: "/" });
});

test("errors 403 for a banned user", async () => {
  expect(thrownBy(await signedIn("U-page-banned", true))).toMatchObject({
    status: 403,
    body: { message: BANNED_MESSAGE },
  });
});

test("returns an ordinary signed-in user", async () => {
  const user = await signedIn("U-page-ok");
  expect(user).not.toBeNull();
  expect(requireUser({ user })).toBe(user!);
});
