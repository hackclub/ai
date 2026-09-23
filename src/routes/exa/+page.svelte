<script lang="ts">
  import ExternalIcon from "remixicon-svelte/icons/external-link-line";
  import CheckIcon from "remixicon-svelte/icons/check-line";
  import CloseIcon from "remixicon-svelte/icons/close-line";
  import CodeBlock from "#lib/components/code-block.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";

  let { data } = $props();

  let tab = $state<"curl" | "javascript" | "python">("curl");
  const tabs = [
    { key: "curl", label: "cURL" },
    { key: "javascript", label: "JavaScript" },
    { key: "python", label: "Python" },
  ] as const;

  const endpoints = [
    {
      path: "search",
      title: "Find pages",
      body: "Neural or keyword search over the web. Returns ranked results with title, URL, and date, and can fetch page contents in the same call.",
      takes: "query, plus optional numResults, type, category, date and domain filters, and a contents block.",
      example: "\"Which startups are building humanoid robots?\"",
    },
    {
      path: "findSimilar",
      title: "More like this",
      body: "Give it a URL and get pages that resemble it. Useful for competitor lists, related reading, and expanding a seed set.",
      takes: "url, plus the same result filters and contents block as search.",
      example: "\"https://arxiv.org/abs/2201.04234\"",
    },
    {
      path: "contents",
      title: "Read pages",
      body: "Fetch clean text, highlights, or an AI summary for URLs you already have. Pair it with search when you want to decide what to read first.",
      takes: "urls, plus text, highlights, or summary options.",
      example: "[\"https://exa.ai\", \"https://hackclub.com\"]",
    },
    {
      path: "answer",
      title: "Ask the web",
      body: "Searches, reads the results, and returns a direct answer with citations. The quickest way to get a grounded reply to a factual question.",
      takes: "query, plus optional text to include the source page contents.",
      example: "\"When was Hack Club founded?\"",
    },
  ];

  const goodFor = [
    "Giving a chat model live web results as tool output or context",
    "Semantic search where the phrasing matters more than exact keywords",
    "Research agents that search, then read the best pages in a second call",
    "Building lists: companies, papers, people, or products matching a description",
    "Fetching readable text from a URL without writing your own scraper",
  ];

  const notFor = [
    "Streaming: every Exa endpoint returns a single JSON body",
    "Crawling whole sites or pulling more than a handful of pages per call",
    "Pages behind a login or paywall, which Exa cannot read",
    "Replacing a chat model: answer is grounded but brief, and the others return raw results",
    "Real-time data such as prices or scores, where the index may lag",
  ];
</script>

<svelte:head><title>Exa</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader
    title="Exa"
    description="Web search built for AI: find pages, read them, and get cited answers"
  >
    {#snippet actions()}
      <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Beta</span>
      <Button href="https://exa.ai/docs/reference/search" target="_blank" rel="noopener" variant="outline" size="sm">
        Exa docs
        <ExternalIcon data-icon="inline-end" class="size-4" />
      </Button>
    {/snippet}
  </PageHeader>

  <section class="mt-10" aria-labelledby="what-heading">
    <h2 id="what-heading" class="mb-4 text-sm font-medium">What's Exa?</h2>
    <div class="bg-card space-y-3 rounded-lg border p-4 text-sm text-pretty">
      <p>
        Exa is a search engine made to be called from code. Instead of ten blue links tuned for people, it returns <strong>structured results</strong> for a natural-language query, and can hand back the <strong>page text</strong> in the same response so a model has something to read.
      </p>
      <p>
        Four endpoints cover the usual loop: <strong>search</strong> for pages, <strong>findSimilar</strong> to expand from a URL, <strong>contents</strong> to read what you found, and <strong>answer</strong> when you want Exa to do all three and reply with citations. Requests are forwarded unchanged and you get Exa's response back as is.
      </p>
    </div>
  </section>

  <section class="mt-10" aria-labelledby="endpoints-heading">
    <h2 id="endpoints-heading" class="mb-4 text-sm font-medium">Endpoints</h2>
    <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each endpoints as item (item.path)}
        <li class="bg-card flex flex-col gap-2 rounded-lg border p-4">
          <div class="flex items-baseline justify-between gap-2">
            <p class="font-mono text-sm font-medium">POST /{item.path}</p>
            <p class="text-muted-foreground text-xs">{item.title}</p>
          </div>
          <p class="text-sm text-pretty">{item.body}</p>
          <p class="text-muted-foreground text-xs text-pretty"><span class="font-medium">Takes:</span> {item.takes}</p>
          <p class="text-muted-foreground mt-auto pt-1 text-xs italic">{item.example}</p>
        </li>
      {/each}
    </ul>
  </section>

  <section class="mt-10" aria-labelledby="fit-heading">
    <h2 id="fit-heading" class="mb-4 text-sm font-medium">When to reach for it</h2>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="bg-card rounded-lg border p-4">
        <p class="mb-2 text-sm font-medium">Good for</p>
        <ul role="list" class="space-y-1.5 text-sm">
          {#each goodFor as item (item)}
            <li class="flex gap-2 text-pretty"><CheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /><span>{item}</span></li>
          {/each}
        </ul>
      </div>
      <div class="bg-card rounded-lg border p-4">
        <p class="mb-2 text-sm font-medium">Not for</p>
        <ul role="list" class="space-y-1.5 text-sm">
          {#each notFor as item (item)}
            <li class="flex gap-2 text-pretty"><CloseIcon class="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" /><span>{item}</span></li>
          {/each}
        </ul>
      </div>
    </div>
  </section>

  <section class="mt-10" aria-labelledby="endpoint-heading">
    <h2 id="endpoint-heading" class="mb-4 text-sm font-medium">Endpoint</h2>
    <dl class="bg-card grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div>
        <dt class="text-muted-foreground text-xs">Base URL</dt>
        <dd class="mt-1 font-mono text-sm break-all">{data.baseUrl}/proxy/v1/exa</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Routes</dt>
        <dd class="mt-1 font-mono text-sm">POST /search · /findSimilar · /contents · /answer</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Pricing</dt>
        <dd class="mt-1 text-sm text-pretty">
          Exa's list price, per request
          <span class="text-muted-foreground">· search from $7 per 1k, contents $1 per 1k pages, answer $5 per 1k</span>
        </dd>
        <dd class="text-muted-foreground mt-0.5 text-xs">
          Every response reports its exact cost in <code class="font-mono">costDollars.total</code>, and that amount counts against your daily allowance.
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Limits</dt>
        <dd class="text-muted-foreground mt-1 text-sm text-pretty">
          Up to 100 results per search. Only <code class="font-mono text-xs">/answer</code> streams; <code class="font-mono text-xs">stream: true</code> on any other endpoint is rejected.
        </dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-muted-foreground text-xs">SDK</dt>
        <dd class="text-muted-foreground mt-1 text-sm text-pretty">
          Exa's own clients work unchanged: set the base URL to the address above and pass your Hack Club AI key as the API key. The proxy accepts it either as a bearer token in <code class="font-mono text-xs">Authorization</code> or in Exa's <code class="font-mono text-xs">x-api-key</code> header.
        </dd>
      </div>
    </dl>
  </section>

  <section class="mt-10" aria-labelledby="examples-heading">
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
    <CodeBlock code={data.examples[tab].code} html={data.examples[tab].html} />
  </section>

  <section class="mt-8" aria-labelledby="response-heading">
    <h2 id="response-heading" class="mb-4 text-sm font-medium">Example response</h2>
    <CodeBlock code={data.response.code} html={data.response.html} />
  </section>
</div>
