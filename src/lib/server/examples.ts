import type { ModelType } from "#lib/format.ts";
import { type HighlightedCode, highlight } from "./highlight";

export type ExampleTab = "curl" | "javascript" | "python";
export type CodeExamples = Record<ExampleTab, HighlightedCode>;

const sources = (
  baseUrl: string,
  id: string,
  modelType: ModelType,
): Record<ExampleTab, string> => {
  if (modelType === "embedding") {
    return {
      curl: `curl ${baseUrl}/proxy/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${id}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'`,
      javascript: `const response = await fetch('${baseUrl}/proxy/v1/embeddings', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${id}',
    input: 'The quick brown fox jumps over the lazy dog',
  }),
});

const data = await response.json();
const embedding = data.data[0].embedding;
console.log(\`Embedding dimensions: \${embedding.length}\`);`,
      python: `from openrouter import OpenRouter

client = OpenRouter(
    api_key="YOUR_API_KEY",
)

response = client.embeddings.generate(
    model="${id}",
    input="The quick brown fox jumps over the lazy dog",
)

embedding = response.data[0].embedding
print(f"Embedding dimensions: {len(embedding)}")`,
    };
  }
  if (modelType === "image") {
    return {
      curl: `curl ${baseUrl}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${id}",
    "messages": [
      {"role": "user", "content": "A sunset over mountains"}
    ],
    "modalities": ["image", "text"],
    "image_config": {
      "aspect_ratio": "16:9"
    }
  }'`,
      javascript: `const response = await fetch('${baseUrl}/proxy/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${id}',
    messages: [
      { role: 'user', content: 'A sunset over mountains' }
    ],
    modalities: ['image', 'text'],
    image_config: {
      aspect_ratio: '16:9'
    }
  }),
});

const data = await response.json();
const imageUrl = data.choices[0].message.images[0].image_url.url;
// imageUrl is a base64 data URL`,
      python: `import base64
import requests

headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

payload = {
    "model": "${id}",
    "messages": [
        {"role": "user", "content": "A sunset over mountains"}
    ],
    "modalities": ["image", "text"],
    "image_config": {
        "aspect_ratio": "16:9"
    }
}

response = requests.post(
    "${baseUrl}/proxy/v1/chat/completions",
    headers=headers,
    json=payload
)

result = response.json()
image_url = result["choices"][0]["message"]["images"][0]["image_url"]["url"]

# Decode base64 image
base64_data = image_url.split(",")[1]
image_bytes = base64.b64decode(base64_data)`,
    };
  }
  return {
    curl: `curl ${baseUrl}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${id}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`,
    javascript: `import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({
  apiKey: 'YOUR_API_KEY',
  baseURL: '${baseUrl}/proxy/v1',
});

const response = await client.chat.send({
  model: '${id}',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(response.choices[0].message.content);`,
    python: `from openrouter import OpenRouter

client = OpenRouter(
    api_key="YOUR_API_KEY",
    server_url="${baseUrl}/proxy/v1",
)

response = client.chat.send(
    model="${id}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
)

print(response.choices[0].message.content)`,
  };
};

/** Highlighted cURL, JavaScript and Python snippets for a model page. */
export async function modelExamples(
  baseUrl: string,
  id: string,
  modelType: ModelType,
): Promise<CodeExamples> {
  const source = sources(baseUrl, id, modelType);
  const [curl, javascript, python] = await Promise.all([
    highlight(source.curl, "bash"),
    highlight(source.javascript, "javascript"),
    highlight(source.python, "python"),
  ]);
  return { curl, javascript, python };
}

/** The one-line quickstart request shown on the dashboard and after key creation. */
export const quickstartCurl = (baseUrl: string, model: string, apiKey = "YOUR_API_KEY") =>
  highlight(
    `curl ${baseUrl}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hi"}]}'`,
    "bash",
  );
