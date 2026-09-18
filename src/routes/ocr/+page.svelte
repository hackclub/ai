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

  const documentTypes = [
    {
      type: "document_url",
      title: "PDFs and office files",
      body: "A PDF, PPTX, or DOCX. Every page comes back as its own entry with Markdown, image placeholders, and dimensions.",
      accepts: "An https:// URL or a base64 data URI.",
      example: "\"document_url\": \"https://example.com/paper.pdf\"",
    },
    {
      type: "image_url",
      title: "Single images",
      body: "A PNG, JPEG, or AVIF. Scans, photographed pages, screenshots, and whiteboards all count as one page.",
      accepts: "An https:// URL or a data:image/…;base64 URI.",
      example: "\"image_url\": \"data:image/png;base64,iVBOR…\"",
    },
  ];

  const goodFor = [
    "Turning PDFs and scans into Markdown you can feed to a chat model",
    "Extracting tables, headings, and equations while keeping document structure",
    "Multilingual documents: Mistral OCR handles over 40 languages",
    "Batch processing where you need a predictable price per page",
    "Pulling figures out of a paper as separate images, with include_image_base64",
  ];

  const notFor = [
    "Asking questions about a document: run OCR first, then send the Markdown to a chat model",
    "Handwriting-heavy or very low-resolution scans, where accuracy drops",
    "Uploading files ahead of time: the file upload endpoint is not proxied, so use a URL or a data URI",
    "Anything you need streamed: the whole document is processed before the response is sent",
    "Files behind authentication: the URL must be reachable by Mistral without credentials",
  ];
</script>

<svelte:head><title>OCR</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader
    title="OCR"
    description="Turn PDFs, slides, and images into Markdown with Mistral OCR"
  >
    {#snippet actions()}
      <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Beta</span>
      <Button href="https://docs.mistral.ai/capabilities/OCR/basic_ocr" target="_blank" rel="noopener" variant="outline" size="sm">
        Mistral docs
        <ExternalIcon data-icon="inline-end" class="size-4" />
      </Button>
    {/snippet}
  </PageHeader>

  <section class="mt-10" aria-labelledby="what-heading">
    <h2 id="what-heading" class="mb-4 text-sm font-medium">What's it for?</h2>
    <div class="bg-card space-y-3 rounded-lg border p-4 text-sm text-pretty">
      <p>
        Chat models read text, not files. Mistral OCR is the step in between: send it a <strong>document</strong> and it returns every page as <strong>Markdown</strong>, with headings, lists, tables, and equations preserved, plus the position of any images. That output is small enough to drop straight into a prompt.
      </p>
      <p>
        The request is forwarded to Mistral unchanged and the full response is returned to you. We store the page count and layout for your activity log, but never the extracted text.
      </p>
    </div>
  </section>

  <section class="mt-10" aria-labelledby="documents-heading">
    <h2 id="documents-heading" class="mb-4 text-sm font-medium">Document types</h2>
    <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each documentTypes as item (item.type)}
        <li class="bg-card flex flex-col gap-2 rounded-lg border p-4">
          <div class="flex items-baseline justify-between gap-2">
            <p class="font-mono text-sm font-medium">{item.type}</p>
            <p class="text-muted-foreground text-xs">{item.title}</p>
          </div>
          <p class="text-sm text-pretty">{item.body}</p>
          <p class="text-muted-foreground text-xs text-pretty"><span class="font-medium">Accepts:</span> {item.accepts}</p>
          <p class="text-muted-foreground mt-auto pt-1 font-mono text-xs break-all">{item.example}</p>
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
        <dt class="text-muted-foreground text-xs">URL</dt>
        <dd class="mt-1 font-mono text-sm break-all">POST {data.baseUrl}/proxy/v1/ocr</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Model</dt>
        <dd class="mt-1 font-mono text-sm">mistral-ocr-latest</dd>
        <dd class="text-muted-foreground mt-0.5 text-xs">Used when the request omits a model</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Pricing</dt>
        <dd class="mt-1 text-sm tabular-nums">
          ${data.pagePriceUsd} per page
          <span class="text-muted-foreground">· an image counts as one page</span>
        </dd>
        <dd class="text-muted-foreground mt-0.5 text-xs">Counts against your daily allowance</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">Limits</dt>
        <dd class="text-muted-foreground mt-1 text-sm text-pretty">
          Mistral's own document size and page limits apply. Streaming is not available.
        </dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-muted-foreground text-xs">SDK</dt>
        <dd class="text-muted-foreground mt-1 text-sm text-pretty">
          Mistral's clients work unchanged: set the server URL to <code class="font-mono text-xs">{data.baseUrl}/proxy</code> and use your Hack Club AI key. Only <code class="font-mono text-xs">/v1/ocr</code> is served; other Mistral endpoints are not proxied.
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
