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

  const questionTypes = [
    {
      type: "noul",
      title: "Is this true?",
      body: "A yes/no question. Returns one number from 0 to 1: the probability the statement holds for the state. The number is the confidence; there is no separate field.",
      criteria: "Instructions only.",
      example: "\"Does this convey urgency?\"",
    },
    {
      type: "choice",
      title: "Which one?",
      body: "Picks one option from a set you define, up to 255. Returns the chosen key, a probability for every option, and an overall confidence.",
      criteria: "A map of option key to description. Include an \"other\" option so the model can say nothing fits.",
      example: "\"Which team should handle this?\"",
    },
    {
      type: "score",
      title: "How much?",
      body: "Places the state on an ordered scale. Returns a score that can land between levels (for example 1.4), plus probabilities and confidence.",
      criteria: "An ordered list of 2 to 10 level descriptions. Level 0 is the first entry.",
      example: "\"How frustrated does the customer sound?\"",
    },
  ];

  const goodFor = [
    "Routing and triage: which queue, team, or workflow a record belongs to",
    "Classification and tagging over tickets, messages, documents or events",
    "Guardrails: does this input break a rule, is this action safe to automate",
    "Severity, tone, or quality scoring at high volume",
    "Any decision your code can act on directly, with a confidence threshold for escalation",
  ];

  const notFor = [
    "Writing anything: it cannot return a value outside your question schema",
    "Chat, summaries, or explanations of its reasoning",
    "Arithmetic and counting: error grows with the size of what is counted",
    "Comparing dates: dates are text to it, not ordered quantities",
    "Decisions that need a written justification for a human reviewer",
  ];
</script>

<svelte:head><title>Jev</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader
    title="Jev"
    description="An ultra-fast model that makes decisions instead of writing text"
  >
    {#snippet actions()}
      <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Beta</span>
      <Button href="https://docs.typesafe.ai/introduction" target="_blank" rel="noopener" variant="outline" size="sm">
        TypeSafe docs
        <ExternalIcon data-icon="inline-end" class="size-4" />
      </Button>
    {/snippet}
  </PageHeader>

  <section class="mt-10" aria-labelledby="what-heading">
    <h2 id="what-heading" class="mb-4 text-sm font-medium">What Jev is</h2>
    <div class="bg-card space-y-3 rounded-lg border p-4 text-sm text-pretty">
      <p>
        Jev is the first of what TypeSafe calls <strong>System One models</strong>, released in September 2026. A chat model generates a reply one token at a time and you parse the result. Jev does not generate text at all. It reads your <strong>state</strong> (e.g. support messages, JSON records) and a map of <strong>questions</strong>, and returns a typed answer to every question in a single parallel pass.
      </p>
      <p>
        Because the answers are drawn from a schema you define, Jev cannot invent an option that does not exist or return something your code cannot handle. Every answer carries a probability, so your software can act when confidence is high and hand off to a person when it is not.
      </p>
    </div>
  </section>

  <section class="mt-10" aria-labelledby="questions-heading">
    <h2 id="questions-heading" class="mb-4 text-sm font-medium">Question types</h2>
    <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {#each questionTypes as item (item.type)}
        <li class="bg-card flex flex-col gap-2 rounded-lg border p-4">
          <div class="flex items-baseline justify-between gap-2">
            <p class="font-mono text-sm font-medium">{item.type}</p>
            <p class="text-muted-foreground text-xs">{item.title}</p>
          </div>
          <p class="text-sm text-pretty">{item.body}</p>
          <p class="text-muted-foreground text-xs text-pretty"><span class="font-medium">Criteria:</span> {item.criteria}</p>
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
        <dd class="mt-1 font-mono text-sm break-all">{data.baseUrl}/proxy/v1/jev</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Routes</dt>
        <dd class="mt-1 font-mono text-sm">POST /systemone · GET /models</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Model</dt>
        <dd class="mt-1 font-mono text-sm">jev-latest</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Pricing</dt>
        <dd class="mt-1 text-sm tabular-nums">
          ${data.inputPricePerMillionUsd} per 1M input tokens
          <span class="text-muted-foreground">· output free</span>
        </dd>
        <dd class="text-muted-foreground mt-0.5 text-xs">Counts against your daily allowance</dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-muted-foreground text-xs">SDK</dt>
        <dd class="text-muted-foreground mt-1 text-sm text-pretty">
          TypeSafe's own clients work unchanged: point the base URL at the address above and use your Hack Club AI key. <code class="font-mono text-xs">/v1/systemone</code> and <code class="font-mono text-xs">/v1/models</code> are served too.
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
    <p class="text-muted-foreground mt-3 text-sm text-pretty">
      Requests are logged under the versioned model the response reports, such as <code class="font-mono text-xs">jev/jev-1.13.0</code>, so <code class="font-mono text-xs">jev-latest</code> stays traceable in your activity.
    </p>
  </section>
</div>
