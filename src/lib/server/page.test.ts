import { describe, expect, test } from "bun:test";

import type { SessionUser } from "../../auth/sessions";
import { requireUser } from "./page.ts";

const sessionUser = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: "user-1",
  slackId: "U123",
  email: "user@example.com",
  name: "User",
  avatar: null,
  isBanned: false,
  isIdvVerified: true,
  skipIdv: false,
  agentBannerDismissedAt: null,
  billingAccountId: "account-1",
  ...overrides,
});

const locals = (user: SessionUser | null): App.Locals =>
  ({ user }) as unknown as App.Locals;

describe("requireUser", () => {
  test("redirects to / when there is no signed-in user", () => {
    let thrown: unknown;
    try {
      requireUser(locals(null));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { status: number }).status).toBe(302);
    expect((thrown as { location: string }).location).toBe("/");
  });

  test("errors 403 for a banned user", () => {
    let thrown: unknown;
    try {
      requireUser(locals(sessionUser({ isBanned: true })));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { status: number }).status).toBe(403);
    expect((thrown as { body: { message: string } }).body.message).toBe(
      "You are banned from using this service.",
    );
  });

  test("returns a normal user as-is", () => {
    const user = sessionUser();
    expect(requireUser(locals(user))).toBe(user);
  });
});
