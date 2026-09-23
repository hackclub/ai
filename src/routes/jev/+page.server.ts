import type { PageServerLoad } from "./$types";

import { highlight } from "#lib/server/highlight.ts";
import { requireUser } from "#lib/server/page.ts";
import type { CodeExamples } from "#lib/server/examples.ts";

const sources = (baseUrl: string) => ({
  curl: `curl ${baseUrl}/proxy/v1/jev/systemone \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "jev-latest",
    "state": "Help! My payouts have been failing for 3 days.",
    "questions": {
      "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" },
      "category": {
        "type": "choice",
        "instructions": "What is this message about?",
        "criteria": {
          "billing": "Payments, invoices, or subscriptions",
          "bug": "Something is broken",
          "feature": "A request for new functionality",
          "other": "Nothing above fits"
        }
      }
    }
  }'`,
  javascript: `const response = await fetch('${baseUrl}/proxy/v1/jev/systemone', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'jev-latest',
    state: 'Help! My payouts have been failing for 3 days.',
    questions: {
      is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
      category: {
        type: 'choice',
        instructions: 'What is this message about?',
        criteria: {
          billing: 'Payments, invoices, or subscriptions',
          bug: 'Something is broken',
          feature: 'A request for new functionality',
          other: 'Nothing above fits',
        },
      },
    },
  }),
});

const data = await response.json();
console.log(data.answers.is_urgent.noul);   // 0.92
console.log(data.answers.category.choice);  // "billing"`,
  python: `import requests

headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
}

payload = {
    "model": "jev-latest",
    "state": "Help! My payouts have been failing for 3 days.",
    "questions": {
        "is_urgent": {"type": "noul", "instructions": "Does this convey urgency?"},
        "category": {
            "type": "choice",
            "instructions": "What is this message about?",
            "criteria": {
          "billing": "Payments, invoices, or subscriptions",
          "bug": "Something is broken",
          "feature": "A request for new functionality",
          "other": "Nothing above fits"
        },
        },
    },
}

response = requests.post(
    "${baseUrl}/proxy/v1/jev/systemone",
    headers=headers,
    json=payload,
)

answers = response.json()["answers"]
print(answers["is_urgent"]["noul"])   # 0.92
print(answers["category"]["choice"])  # "billing"`,
});

const responseExample = `{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.92 },
    "category": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.87, "bug": 0.09, "feature": 0.01, "other": 0.03 },
      "confidence": 0.87
    }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}`;

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  const { site } = locals.dashboard;
  const baseUrl = site.baseUrl;
  const source = sources(baseUrl);
  const [curl, javascript, python, response] = await Promise.all([
    highlight(source.curl, "bash"),
    highlight(source.javascript, "javascript"),
    highlight(source.python, "python"),
    highlight(responseExample, "javascript"),
  ]);
  const examples: CodeExamples = { curl, javascript, python };
  return {
    baseUrl,
    examples,
    response,
    inputPricePerMillionUsd: site.jevInputPricePerMillionUsd,
  };
};
