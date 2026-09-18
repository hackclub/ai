import type { PageServerLoad } from "./$types";

import { highlight } from "#lib/server/highlight.ts";
import { requireUser } from "#lib/server/page.ts";
import type { CodeExamples } from "#lib/server/examples.ts";

const sources = (baseUrl: string) => ({
  curl: `curl ${baseUrl}/proxy/v1/exa/search \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "open source alternatives to Notion",
    "numResults": 3,
    "contents": { "text": { "maxCharacters": 500 } }
  }'`,
  javascript: `const response = await fetch('${baseUrl}/proxy/v1/exa/search', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'open source alternatives to Notion',
    numResults: 3,
    contents: { text: { maxCharacters: 500 } },
  }),
});

const data = await response.json();
for (const result of data.results) {
  console.log(result.title, result.url);
  console.log(result.text);
}`,
  python: `import requests

headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
}

payload = {
    "query": "open source alternatives to Notion",
    "numResults": 3,
    "contents": {"text": {"maxCharacters": 500}},
}

response = requests.post(
    "${baseUrl}/proxy/v1/exa/search",
    headers=headers,
    json=payload,
)

for result in response.json()["results"]:
    print(result["title"], result["url"])
    print(result["text"])`,
});

const responseExample = `{
  "requestId": "b5947044c4b78efa9552a7c89b306d95",
  "resolvedSearchType": "neural",
  "results": [
    {
      "id": "https://github.com/AppFlowy-IO/AppFlowy",
      "title": "AppFlowy: an open-source alternative to Notion",
      "url": "https://github.com/AppFlowy-IO/AppFlowy",
      "publishedDate": "2025-03-10T00:00:00.000Z",
      "author": "AppFlowy-IO",
      "text": "AppFlowy is an AI collaborative workspace where you achieve more without losing control of your data..."
    }
  ],
  "costDollars": {
    "total": 0.008,
    "search": { "neural": 0.007 },
    "contents": { "text": 0.001 }
  }
}`;

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  const baseUrl = locals.backend.env.baseUrl;
  const source = sources(baseUrl);
  const [curl, javascript, python, response] = await Promise.all([
    highlight(source.curl, "bash"),
    highlight(source.javascript, "javascript"),
    highlight(source.python, "python"),
    highlight(responseExample, "javascript"),
  ]);
  const examples: CodeExamples = { curl, javascript, python };
  return { baseUrl, examples, response };
};
