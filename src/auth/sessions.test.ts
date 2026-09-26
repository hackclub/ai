import { describe, expect, test } from "bun:test";

import { testDatabase } from "../test/database";
import { cookieValue, createSessions } from "./sessions";
import { createUser } from "./users";

const { sql } = await testDatabase();

let users = 0;
const newUser = () => createUser(sql, { slackId: `U-session-${++users}` });
/** The Cookie request header a browser sends back for a Set-Cookie value. */
const cookieHeaderFrom = (setCookie: string) => setCookie.split(";")[0] ?? "";
const storedHashes = async (userId: string) =>
  (await sql<{ token_hash: Uint8Array }[]>`SELECT token_hash FROM sessions WHERE user_id = ${userId}::uuid`).map(
    (row) => new Uint8Array(row.token_hash),
  );

test.each([
  ["a=1; session_token=abc%3D%3D; b=2", "abc=="],
  ["a=1", undefined],
  [null, undefined],
  // Not valid percent-encoding: a sibling host's cookie must not 500 every page.
  ["session_token=%E0", undefined],
  ["session_token=%", undefined],
  // Two cookies with one name means one was planted from the parent domain.
  ["session_token=a; session_token=b", undefined],
])("cookieValue(%p) is %p", (header, expected) => {
  expect(cookieValue(header, "session_token")).toBe(expected);
});

describe("session owner with PostgreSQL", () => {
  test("secure sessions use the __Host- name and ignore the bare name", async () => {
    const created = await newUser();
    const sessions = createSessions({ sql, secureCookies: true });
    const setCookie = await sessions.start(created.userId);
    expect(setCookie).toStartWith("__Host-session_token=");
    expect(setCookie).toEndWith("; Secure");

    const header = cookieHeaderFrom(setCookie);
    expect(await sessions.user(header.replace(/^__Host-/, ""))).toBeNull();
    expect((await sessions.user(header))?.id).toBe(created.userId);
  });

  test("the stored hash is the SHA-256 of the token, so existing sessions stay valid", async () => {
    const created = await newUser();
    const setCookie = await createSessions({ sql, secureCookies: false }).start(created.userId);
    const token = cookieValue(cookieHeaderFrom(setCookie), "session_token") ?? "";
    expect(token).not.toBe("");
    const expected = new Uint8Array(new Bun.CryptoHasher("sha256").update(token).digest());
    expect(await storedHashes(created.userId)).toEqual([expected]);
  });

  test("an expired session reads as signed out", async () => {
    const created = await newUser();
    const sessions = createSessions({ sql, secureCookies: false });
    const header = cookieHeaderFrom(await sessions.start(created.userId));
    await sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = ${created.userId}::uuid`;
    expect(await sessions.user(header)).toBeNull();
  });
});
