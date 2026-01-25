import type { OpenRouterModel } from "../lib/models";
import type { ModelType, User } from "../types";
import { Header } from "./components/Header";
import { Check, ChevronDown, Copy } from "./components/Icons";
import { Layout } from "./layout";

type ModelPageProps = {
  model: OpenRouterModel;
  modelType: ModelType;
  user: User;
};

function formatPricing(pricePerToken?: string): string {
  if (!pricePerToken) return "N/A";
  const price = parseFloat(pricePerToken) * 1_000_000;
  if (price === 0) return "Free";
  if (price < 0.01) return `$${price.toFixed(4)}`;
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

function formatContextLength(length?: number): string {
  if (!length) return "N/A";
  return length.toLocaleString();
}

// Strip markdown links from text
function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function getProviderName(modelId: string): string {
  const parts = modelId.split("/");
  if (parts.length >= 1) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return "Unknown";
}

function formatModality(model: OpenRouterModel): string {
  if (model.architecture?.modality) {
    return model.architecture.modality.replace("->", " → ");
  }
  const inputs = model.architecture?.input_modalities?.join(", ") || "text";
  const outputs = model.architecture?.output_modalities?.join(", ") || "text";
  return `${inputs} → ${outputs}`;
}

const InfoCard = ({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string;
  subtext?: string;
}) => (
  <div class="bg-brand-surface border-2 border-brand-border rounded-xl p-4">
    <div class="text-sm text-brand-text mb-1">{label}</div>
    <div class="text-xl font-bold text-brand-heading">{value}</div>
    {subtext && <div class="text-xs text-brand-text mt-1">{subtext}</div>}
  </div>
);

const CodeBlock = ({ code }: { code: string }) => {
  // Escape for use in JavaScript template literal
  const escapedCode = code
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  return (
    <div class="relative" x-data="{ copied: false }">
      <button
        type="button"
        x-on:click={`navigator.clipboard.writeText(\`${escapedCode}\`); copied = true; setTimeout(() => copied = false, 2000)`}
        class="absolute top-3 right-3 p-2 rounded-lg bg-brand-bg/80 hover:bg-brand-bg border border-brand-border transition-colors"
        title="Copy code"
      >
        <span x-show="!copied">
          <Copy class="w-4 h-4 text-brand-text" />
        </span>
        <span x-show="copied" x-cloak>
          <Check class="w-4 h-4 text-green-500" />
        </span>
      </button>
      <pre class="bg-brand-bg border-2 border-brand-border rounded-xl p-4 pr-14 overflow-x-auto">
        <code class="text-sm font-mono text-brand-heading whitespace-pre">
          {code}
        </code>
      </pre>
    </div>
  );
};

const CodeExamples = ({
  model,
  modelType,
}: {
  model: OpenRouterModel;
  modelType: ModelType;
}) => {
  const modelId = model.id;

  const curlExample =
    modelType === "embedding"
      ? `curl https://ai.hackclub.com/proxy/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'`
      : modelType === "image"
        ? `curl https://ai.hackclub.com/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [
      {"role": "user", "content": "A sunset over mountains"}
    ],
    "modalities": ["image", "text"],
    "image_config": {
      "aspect_ratio": "16:9"
    }
  }'`
        : `curl https://ai.hackclub.com/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

  const jsExample =
    modelType === "embedding"
      ? `const response = await fetch('https://ai.hackclub.com/proxy/v1/embeddings', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${modelId}',
    input: 'The quick brown fox jumps over the lazy dog',
  }),
});

const data = await response.json();
const embedding = data.data[0].embedding;
console.log(\`Embedding dimensions: \${embedding.length}\`);`
      : modelType === "image"
        ? `const response = await fetch('https://ai.hackclub.com/proxy/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${modelId}',
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
// imageUrl is a base64 data URL`
        : `import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({
  apiKey: 'YOUR_API_KEY',
  baseURL: 'https://ai.hackclub.com/proxy/v1',
});

const response = await client.chat.send({
  model: '${modelId}',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(response.choices[0].message.content);`;

  const pythonExample =
    modelType === "embedding"
      ? `from openrouter import OpenRouter

client = OpenRouter(
    api_key="YOUR_API_KEY",
)

response = client.embeddings.generate(
    model="${modelId}",
    input="The quick brown fox jumps over the lazy dog",
)

embedding = response.data[0].embedding
print(f"Embedding dimensions: {len(embedding)}")`
      : modelType === "image"
        ? `import base64
import requests

headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

payload = {
    "model": "${modelId}",
    "messages": [
        {"role": "user", "content": "A sunset over mountains"}
    ],
    "modalities": ["image", "text"],
    "image_config": {
        "aspect_ratio": "16:9"
    }
}

response = requests.post(
    "https://ai.hackclub.com/proxy/v1/chat/completions",
    headers=headers,
    json=payload
)

result = response.json()
image_url = result["choices"][0]["message"]["images"][0]["image_url"]["url"]

# Decode base64 image
base64_data = image_url.split(",")[1]
image_bytes = base64.b64decode(base64_data)`
        : `from openrouter import OpenRouter

client = OpenRouter(
    api_key="YOUR_API_KEY",
    server_url="https://ai.hackclub.com/proxy/v1",
)

response = client.chat.send(
    model="${modelId}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
)

print(response.choices[0].message.content)`;

  return (
    <div x-data="{ activeTab: 'curl' }">
      <div class="flex gap-1 mb-4 bg-brand-bg rounded-xl p-1 inline-flex">
        <button
          type="button"
          x-on:click="activeTab = 'curl'"
          x-bind:class="activeTab === 'curl' ? 'bg-brand-surface shadow-sm text-brand-heading' : 'text-brand-text hover:text-brand-heading'"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
        >
          cURL
        </button>
        <button
          type="button"
          x-on:click="activeTab = 'javascript'"
          x-bind:class="activeTab === 'javascript' ? 'bg-brand-surface shadow-sm text-brand-heading' : 'text-brand-text hover:text-brand-heading'"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
        >
          JavaScript
        </button>
        <button
          type="button"
          x-on:click="activeTab = 'python'"
          x-bind:class="activeTab === 'python' ? 'bg-brand-surface shadow-sm text-brand-heading' : 'text-brand-text hover:text-brand-heading'"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
        >
          Python
        </button>
      </div>

      <div x-show="activeTab === 'curl'">
        <CodeBlock code={curlExample} />
      </div>
      <div x-show="activeTab === 'javascript'" x-cloak>
        <CodeBlock code={jsExample} />
      </div>
      <div x-show="activeTab === 'python'" x-cloak>
        <CodeBlock code={pythonExample} />
      </div>
    </div>
  );
};

const BackArrow = () => (
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <title>Go back</title>
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M10 19l-7-7m0 0l7-7m-7 7h18"
    />
  </svg>
);

export const ModelPage = ({ model, modelType, user }: ModelPageProps) => {
  const displayName = model.name || model.id;
  const provider = getProviderName(model.id);
  const description = model.description
    ? stripMarkdownLinks(model.description)
    : null;

  const contextLength = formatContextLength(model.context_length);
  const inputPricing = formatPricing(model.pricing?.prompt);
  const outputPricing = formatPricing(model.pricing?.completion);
  const maxOutputTokens = model.top_provider?.max_completion_tokens
    ? model.top_provider.max_completion_tokens.toLocaleString()
    : "Unlimited";

  const modality = formatModality(model);
  const tokenizer = model.architecture?.tokenizer || "Unknown";
  const isModerated = model.top_provider?.is_moderated ? "Yes" : "No";

  const modelTypeLabel =
    modelType === "embedding"
      ? "Embedding Model"
      : modelType === "image"
        ? "Image Generation Model"
        : "Language Model";

  const modelTypeColor =
    modelType === "embedding"
      ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
      : modelType === "image"
        ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
        : "bg-green-500/10 text-green-400 border border-green-500/20";

  return (
    <Layout title={`${displayName} - Hack Club AI`} includeAlpine user={user}>
      <Header title="hackai" user={user} />

      <div class="w-full max-w-6xl mx-auto px-4 py-8">
        {/* Back link */}
        <a
          href="/dashboard"
          class="inline-flex items-center gap-2 text-brand-text hover:text-brand-heading transition-colors mb-6"
        >
          <BackArrow />
          <span>Back to Dashboard</span>
        </a>

        {/* Model header */}
        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6 mb-6">
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-3 mb-2">
                <span
                  class={`px-3 py-1 rounded-full text-xs font-medium ${modelTypeColor}`}
                >
                  {modelTypeLabel}
                </span>
                <span class="text-sm text-brand-text">{provider}</span>
              </div>
              <h1 class="text-2xl sm:text-3xl font-bold text-brand-heading mb-2">
                {displayName}
              </h1>
              <div class="flex items-center gap-2" x-data="{ copied: false }">
                <button
                  type="button"
                  x-on:click={`navigator.clipboard.writeText('${model.id}'); copied = true; setTimeout(() => copied = false, 2000)`}
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-bg border border-brand-border hover:border-brand-primary/50 transition-colors cursor-pointer group"
                  title="Click to copy model ID"
                >
                  <code class="text-sm font-mono text-brand-primary">
                    {model.id}
                  </code>
                  <span x-show="!copied">
                    <Copy class="w-4 h-4 text-brand-text/50 group-hover:text-brand-primary transition-colors" />
                  </span>
                  <span x-show="copied" x-cloak>
                    <Check class="w-4 h-4 text-green-500" />
                  </span>
                </button>
              </div>
            </div>
          </div>

          {description && (
            <p class="text-brand-text mt-4 leading-relaxed">{description}</p>
          )}
        </div>

        {/* Stats cards */}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <InfoCard
            label="Context Window"
            value={contextLength}
            subtext="tokens"
          />
          <InfoCard
            label="Input Price"
            value={inputPricing}
            subtext="per 1M tokens"
          />
          {modelType !== "embedding" && (
            <InfoCard
              label="Output Price"
              value={outputPricing}
              subtext="per 1M tokens"
            />
          )}
          {modelType !== "embedding" && (
            <InfoCard
              label="Max Output"
              value={maxOutputTokens}
              subtext="tokens"
            />
          )}
          {modelType === "embedding" && (
            <InfoCard label="Modality" value={modality} />
          )}
          {modelType === "embedding" && (
            <InfoCard label="Tokenizer" value={tokenizer} />
          )}
        </div>

        {/* Architecture details */}
        <div
          class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6 mb-6"
          x-data="{ expanded: false }"
        >
          <button
            type="button"
            x-on:click="expanded = !expanded"
            class="flex items-center justify-between w-full text-left"
          >
            <h2 class="text-xl font-bold text-brand-heading">
              Technical Details
            </h2>
            <ChevronDown
              class="w-5 h-5 text-brand-text transition-transform"
              x-bind:class="expanded ? 'rotate-180' : ''"
            />
          </button>

          <div
            x-show="expanded"
            x-transition:enter="transition ease-out duration-200"
            x-transition:enter-start="opacity-0 -translate-y-2"
            x-transition:enter-end="opacity-100 translate-y-0"
            x-cloak
          >
            <div class="mt-4 pt-4 border-t border-brand-border">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div class="text-sm text-brand-text mb-1">Modality</div>
                  <div class="font-medium text-brand-heading">{modality}</div>
                </div>
                <div>
                  <div class="text-sm text-brand-text mb-1">Tokenizer</div>
                  <div class="font-medium text-brand-heading">{tokenizer}</div>
                </div>
                <div>
                  <div class="text-sm text-brand-text mb-1">Moderated</div>
                  <div class="font-medium text-brand-heading">
                    {isModerated}
                  </div>
                </div>
                {model.architecture?.instruct_type && (
                  <div>
                    <div class="text-sm text-brand-text mb-1">
                      Instruct Type
                    </div>
                    <div class="font-medium text-brand-heading">
                      {model.architecture.instruct_type}
                    </div>
                  </div>
                )}
              </div>

              {model.architecture?.input_modalities && (
                <div class="mt-4">
                  <div class="text-sm text-brand-text mb-2">
                    Input Modalities
                  </div>
                  <div class="flex flex-wrap gap-2">
                    {model.architecture.input_modalities.map((m) => (
                      <span class="px-2 py-1 bg-brand-bg rounded-lg text-sm text-brand-heading">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {model.architecture?.output_modalities && (
                <div class="mt-4">
                  <div class="text-sm text-brand-text mb-2">
                    Output Modalities
                  </div>
                  <div class="flex flex-wrap gap-2">
                    {model.architecture.output_modalities.map((m) => (
                      <span class="px-2 py-1 bg-brand-bg rounded-lg text-sm text-brand-heading">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Code examples */}
        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6">
          <h2 class="text-xl font-bold text-brand-heading mb-4">
            Code Examples
          </h2>
          <CodeExamples model={model} modelType={modelType} />
        </div>
      </div>
    </Layout>
  );
};
