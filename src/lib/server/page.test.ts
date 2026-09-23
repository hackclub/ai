import { expect, test } from "bun:test";

import type { SessionUser } from "../../auth/sessions";
import { requireUser } from "./page.ts";

const thrownBy = (sessionUser: SessionUser | null) => {
  try {
    requireUser({ user: sessionUser } as unknown as App.Locals);
  } catch (error) {
    return error as { status: number; location?: string; body?: { message: string } };
  }
  throw new Error("expected requireUser to throw");
};

test("redirects to / when there is no signed-in user", () => {
  expect(thrownBy(null)).toMatchObject({ status: 302, location: "/" });
});

test("errors 403 for a banned user", () => {
  expect(thrownBy({ id: "user-1", isBanned: true } as SessionUser)).toMatchObject({
    status: 403,
    body: { message: "You are banned from using this service." },
  });
});
