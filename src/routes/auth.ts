import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { users, sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { setCookie, getCookie } from "hono/cookie";
import { env } from "../env";
import type { AppVariables } from "../types";

async function checkIdvStatus(slackId: string, email: string): Promise<boolean> {
  try {
    const urlBySlackId = new URL("https://identity.hackclub.com/api/external/check");
    urlBySlackId.searchParams.append("slack_id", slackId);

    const slackResponse = await fetch(urlBySlackId);
    if (slackResponse.ok) {
      const data = await slackResponse.json();
      if (data.result === "verified_eligible") {
        return true;
      }
    }

    if (!email) return false;

    const urlByEmail = new URL("https://identity.hackclub.com/api/external/check");
    urlByEmail.searchParams.append("email", email);

    const emailResponse = await fetch(urlByEmail);
    if (!emailResponse.ok) return false;

    const data = await emailResponse.json();
    return data.result === "verified_eligible";
  } catch (error) {
    console.error("IDV check error:", error);
    return false;
  }
}

const auth = new Hono<{ Variables: AppVariables }>();

function parseJwt(slackIdToken: string) {
  const base64Url = slackIdToken.split(".")[1];
  if (!base64Url) {
    console.error("No Base64 URL in the JWT");
    throw new HTTPException(400, { message: "Bad Slack OpenID response" });
  }

  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const jsonPayload = decodeURIComponent(
    Buffer.from(base64, "base64")
      .toString("utf-8")
      .split("")
      .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
      .join(""),
  );

  return JSON.parse(jsonPayload);
}

auth.get("/login", (c) => {
  const clientId = env.SLACK_CLIENT_ID;
  const redirectUri = `${env.BASE_URL}/auth/callback`;
  const slackAuthUrl = `https://hackclub.slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=openid,profile,email&redirect_uri=${redirectUri}`;
  return c.redirect(slackAuthUrl);
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");

  if (!code) {
    return c.redirect("/");
  }

  try {
    const exchangeUrl = new URL("https://slack.com/api/openid.connect.token");
    const exchangeSearchParams = exchangeUrl.searchParams;
    exchangeSearchParams.append("client_id", env.SLACK_CLIENT_ID);
    exchangeSearchParams.append("client_secret", env.SLACK_CLIENT_SECRET);
    exchangeSearchParams.append("code", code);
    exchangeSearchParams.append(
      "redirect_uri",
      `${env.BASE_URL}/auth/callback`,
    );

    const oidcResponse = await fetch(exchangeUrl, { method: "POST" });

    if (oidcResponse.status !== 200) {
      throw new HTTPException(400, {
        message: "Bad Slack OpenID response status",
      });
    }

    const responseJson = (await oidcResponse.json()) as any;

    if (!responseJson.ok) {
      console.error(responseJson);
      throw new HTTPException(401, {
        message:
          responseJson.error === "invalid_code"
            ? "Invalid Slack OAuth code"
            : "Bad Slack OpenID response",
      });
    }

    const jwt = parseJwt(responseJson.id_token);
    const slackId = jwt["https://slack.com/user_id"];
    const slackTeamId = jwt["https://slack.com/team_id"];
    const avatarUrl = jwt.picture;
    const displayName = jwt.name;
    const email = jwt.email;

    if (slackTeamId !== env.SLACK_TEAM_ID) {
      throw new HTTPException(403, {
        message: "Access denied: Invalid workspace",
      });
    }

    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.slackId, slackId))
      .limit(1);

    const isIdvVerified = await checkIdvStatus(slackId, email);

    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          slackId,
          slackTeamId,
          email,
          name: displayName,
          avatar: avatarUrl,
          isIdvVerified,
        })
        .returning();
    } else {
      [user] = await db
        .update(users)
        .set({
          email,
          name: displayName,
          avatar: avatarUrl,
          isIdvVerified,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))
        .returning();
    }

    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await db.insert(sessions).values({
      userId: user.id,
      token: sessionToken,
      expiresAt,
    });

    setCookie(c, "session_token", sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });

    return c.redirect("/dashboard");
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    console.error("Auth error:", error);
    throw new HTTPException(500, { message: "Authentication error" });
  }
});

auth.get("/logout", async (c) => {
  const sessionToken = getCookie(c, "session_token");

  if (sessionToken) {
    await db.delete(sessions).where(eq(sessions.token, sessionToken));
  }

  setCookie(c, "session_token", "", {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: 0,
    path: "/",
  });

  return c.redirect("/");
});

export default auth;
