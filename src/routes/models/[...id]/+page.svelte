<script lang="ts">
  import ArrowLeftIcon from "remixicon-svelte/icons/arrow-left-line";
  import ArrowDownIcon from "remixicon-svelte/icons/arrow-down-s-line";
  import { Button } from "#lib/components/ui/button/index.ts";
  import CodeBlock from "#lib/components/code-block.svelte";
  import CopyButton from "#lib/components/copy-button.svelte";
  import { formatModality, formatPerMillion, providerName, stripMarkdownLinks } from "#lib/format.ts";

  let { data } = $props();

  const model = $derived(data.model);
  const modelType = $derived(data.modelType);
  const displayName = $derived(model.name || model.id);
  const description = $derived(model.description ? stripMarkdownLinks(model.description) : null);
  const maxOutput = $derived(
    model.top_provider?.max_completion_tokens ? model.top_provider.max_completion_tokens.toLocaleString() : "Unlimited",
  );
  const typeLabel = $derived(
    modelType === "embedding" ? "Embedding" : modelType === "image" ? "Image generation" : "Language",
  );

  let detailsOpen = $state(false);
  let tab = $state<"curl" | "javascript" | "python">("curl");

  const examples = $derived.by(() => {
    const id = model.id;
    if (modelType === "embedding") {
      return {
        curl: `curl https://ai.hackclub.com/proxy/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${id}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'`,
        javascript: `const response = await fetch('https://ai.hackclub.com/proxy/v1/embeddings', {
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
        curl: `curl https://ai.hackclub.com/proxy/v1/chat/completions \\
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
        javascript: `const response = await fetch('https://ai.hackclub.com/proxy/v1/chat/completions', {
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
    "https://ai.hackclub.com/proxy/v1/chat/completions",
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
      curl: `curl https://ai.hackclub.com/proxy/v1/chat/completions \\
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
  baseURL: 'https://ai.hackclub.com/proxy/v1',
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
    server_url="https://ai.hackclub.com/proxy/v1",
)

response = client.chat.send(
    model="${id}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
)

print(response.choices[0].message.content)`,
    };
  });

  const tabs = [
    { key: "curl", label: "cURL" },
    { key: "javascript", label: "JavaScript" },
    { key: "python", label: "Python" },
  ] as const;

  const facts = $derived(
    modelType === "embedding"
      ? [
          { label: "Context window", value: model.context_length ? model.context_length.toLocaleString() : "N/A", note: "tokens" },
          { label: "Input price", value: formatPerMillion(model.pricing?.prompt), note: "per 1M tokens" },
          { label: "Modality", value: formatModality(model) },
          { label: "Tokenizer", value: model.architecture?.tokenizer || "Unknown" },
        ]
      : [
          { label: "Context window", value: model.context_length ? model.context_length.toLocaleString() : "N/A", note: "tokens" },
          { label: "Input price", value: formatPerMillion(model.pricing?.prompt), note: "per 1M tokens" },
          { label: "Output price", value: formatPerMillion(model.pricing?.completion), note: "per 1M tokens" },
          { label: "Max output", value: maxOutput, note: "tokens" },
        ],
  );
</script>

<svelte:head><title>{displayName} · Models</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <Button href="/models" variant="ghost" size="sm" class="-ms-2 mb-6">
    <ArrowLeftIcon data-icon="inline-start" class="size-4" />
    All models
  </Button>

  <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <div class="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        <span class="bg-muted text-foreground rounded-full px-2 py-0.5">{typeLabel}</span>
        <span>{providerName(model.id)}</span>
      </div>
      <h1 class="mt-2 text-balance text-2xl font-semibold tracking-tight">{displayName}</h1>
      {#if description}
        <p class="text-muted-foreground mt-2 max-w-[70ch] text-pretty text-base sm:text-sm">{description}</p>
      {/if}
    </div>
    <CopyButton text={model.id} class="shrink-0" />
  </div>

  <dl class="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
    {#each facts as fact (fact.label)}
      <div class="bg-card flex flex-col gap-1 px-4 py-4 sm:px-5">
        <dt class="text-muted-foreground text-xs font-medium">{fact.label}</dt>
        <dd class="text-xl font-semibold tracking-tight tabular-nums">{fact.value}</dd>
        {#if fact.note}<dd class="text-muted-foreground text-xs">{fact.note}</dd>{/if}
      </div>
    {/each}
  </dl>

  <section class="mt-8 rounded-lg border" aria-labelledby="details-heading">
    <button
      type="button"
      onclick={() => (detailsOpen = !detailsOpen)}
      aria-expanded={detailsOpen}
      class="hover:bg-muted/60 flex w-full items-center justify-between rounded-lg px-5 py-4 text-left transition-colors"
    >
      <h2 id="details-heading" class="text-sm font-medium">Technical details</h2>
      <ArrowDownIcon class="text-muted-foreground size-4 transition-transform {detailsOpen ? 'rotate-180' : ''}" />
    </button>
    {#if detailsOpen}
      <div class="border-t px-5 py-4">
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt class="text-muted-foreground text-xs font-medium">Modality</dt>
            <dd class="mt-1 text-sm">{formatModality(model)}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs font-medium">Tokenizer</dt>
            <dd class="mt-1 text-sm">{model.architecture?.tokenizer || "Unknown"}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs font-medium">Moderated</dt>
            <dd class="mt-1 text-sm">{model.top_provider?.is_moderated ? "Yes" : "No"}</dd>
          </div>
          {#if model.architecture?.instruct_type}
            <div>
              <dt class="text-muted-foreground text-xs font-medium">Instruct type</dt>
              <dd class="mt-1 text-sm">{model.architecture.instruct_type}</dd>
            </div>
          {/if}
          {#if model.architecture?.input_modalities}
            <div>
              <dt class="text-muted-foreground text-xs font-medium">Input modalities</dt>
              <dd class="mt-1 flex flex-wrap gap-1.5">
                {#each model.architecture.input_modalities as modality (modality)}
                  <span class="bg-muted rounded-md px-2 py-0.5 text-xs">{modality}</span>
                {/each}
              </dd>
            </div>
          {/if}
          {#if model.architecture?.output_modalities}
            <div>
              <dt class="text-muted-foreground text-xs font-medium">Output modalities</dt>
              <dd class="mt-1 flex flex-wrap gap-1.5">
                {#each model.architecture.output_modalities as modality (modality)}
                  <span class="bg-muted rounded-md px-2 py-0.5 text-xs">{modality}</span>
                {/each}
              </dd>
            </div>
          {/if}
        </dl>
      </div>
    {/if}
  </section>

  <section class="mt-8" aria-labelledby="examples-heading">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 id="examples-heading" class="text-sm font-medium">Code examples</h2>
      <div class="bg-muted inline-flex gap-1 rounded-md p-1" role="tablist" aria-label="Language">
        {#each tabs as item (item.key)}
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onclick={() => (tab = item.key)}
            class="rounded-sm px-3 py-1 text-xs font-medium transition-colors {tab === item.key
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground'}"
          >
            {item.label}
          </button>
        {/each}
      </div>
    </div>
    <CodeBlock code={examples[tab]} />
  </section>
</div>
