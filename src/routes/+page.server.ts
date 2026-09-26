import { redirect } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

import { highlight } from "#lib/server/highlight.ts";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) redirect(302, "/dashboard");
  const { baseUrl, featuredModel } = locals.dashboard.site;
  const example = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/proxy/v1",
    api_key="sk-hc-v1-...",
)

reply = client.chat.completions.create(
    model="${featuredModel}",
    messages=[{"role": "user", "content": "Hi!"}],
)
print(reply.choices[0].message.content)`;
  return { example: await highlight(example, "python") };
};
