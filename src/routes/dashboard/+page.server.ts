import type { PageServerLoad } from "./$types";

import { quickstartCurl } from "#lib/server/examples.ts";
import { requireUser } from "#lib/server/page.ts";
import { randomQuote } from "#lib/server/quotes.ts";

const LAST_QUOTE_COOKIE = "last_quote";

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const user = requireUser(locals);
  const env = locals.backend.env;
  const [stats, curlExample] = await Promise.all([
    locals.backend.queries.userStats(user.billingAccountId),
    quickstartCurl(env.baseUrl, env.featuredModels[0] ?? "openai/gpt-4o-mini"),
  ]);
  const lastIndex = Number.parseInt(cookies.get(LAST_QUOTE_COOKIE) ?? "", 10);
  const quote = randomQuote(Number.isNaN(lastIndex) ? undefined : lastIndex);
  cookies.set(LAST_QUOTE_COOKIE, String(quote.index), { path: "/dashboard", httpOnly: true, sameSite: "lax" });
  return { stats, curlExample, quote: quote.text };
};
