<script lang="ts">
  import ArrowRightIcon from "remixicon-svelte/icons/arrow-right-line";
  import CodeBlock from "#lib/components/code-block.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import DarkModeToggle from "#lib/components/layout/dark-mode-toggle.svelte";

  let { data } = $props();

  const features = [
    { title: "Language models", body: "Every model OpenRouter lists, from frontier models to small open ones." },
    { title: "Images and embeddings", body: "Generate images and embed text through the same endpoint." },
    { title: "Web search", body: "Search the web, read pages and get cited answers with Exa." },
    { title: "OCR", body: "Turn PDFs and images into Markdown with Mistral OCR." },
    { title: "Replicate", body: "Run speech, music, video and image models. In beta." },
    { title: "Usage dashboard", body: "See every request, token and cent, and inspect what was sent." },
  ];

  const steps = [
    "Sign in with your Hack Club account.",
    "Create an API key.",
    "Point any OpenAI SDK at the base URL.",
  ];
</script>

<svelte:head><title>Hack Club AI</title></svelte:head>

<div class="flex min-h-svh flex-col">
  <header class="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
    <a href="/" class="flex items-center gap-2 text-sm font-semibold">
      <span class="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md text-xs font-bold">h</span>
      Hack Club AI
    </a>
    <nav class="flex items-center gap-1">
      <Button href="https://docs.ai.hackclub.com" target="_blank" rel="noopener" variant="ghost" size="sm">Docs</Button>
      <Button href="https://github.com/hackclub/ai" target="_blank" rel="noopener" variant="ghost" size="sm" class="max-sm:hidden">GitHub</Button>
      <DarkModeToggle />
      <Button href="/auth/login" data-sveltekit-reload variant="outline" size="sm" class="ms-1">Sign in</Button>
    </nav>
  </header>

  <main class="flex-1">
    <section class="mx-auto grid w-full max-w-5xl items-center gap-10 px-4 pt-14 pb-16 sm:px-6 sm:pt-24 lg:grid-cols-[1fr_1.1fr] lg:gap-14 lg:px-8">
      <div>
        <h1 class="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Free AI APIs for Hack Clubbers.</h1>
        <p class="text-muted-foreground mt-5 max-w-[48ch] text-lg text-pretty">
          Every model on OpenRouter, plus image generation, embeddings, web search and OCR, behind one OpenAI-compatible API. No credit card.
        </p>
        <div class="mt-8 flex flex-wrap items-center gap-3">
          <Button href="/auth/login" data-sveltekit-reload size="lg" class="h-11 px-5">
            Sign in with Hack Club
            <ArrowRightIcon data-icon="inline-end" class="size-4" />
          </Button>
          <Button href="https://docs.ai.hackclub.com" target="_blank" rel="noopener" variant="ghost" size="lg" class="h-11 px-4">
            Read the docs
          </Button>
        </div>
      </div>
      <div class="min-w-0 [&_.code-block]:bg-card [&_.code-block]:shadow-xs [&_.shiki]:text-[13px]">
        <CodeBlock code={data.example.code} html={data.example.html} />
      </div>
    </section>

    <section class="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8" aria-labelledby="features-heading">
      <h2 id="features-heading" class="text-muted-foreground mb-6 text-sm font-medium">What you get</h2>
      <dl class="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {#each features as feature (feature.title)}
          <div class="border-t pt-4">
            <dt class="text-sm font-medium">{feature.title}</dt>
            <dd class="text-muted-foreground mt-1 text-sm text-pretty">{feature.body}</dd>
          </div>
        {/each}
      </dl>
    </section>

    <section class="mx-auto w-full max-w-5xl px-4 pt-12 pb-20 sm:px-6 lg:px-8" aria-labelledby="start-heading">
      <h2 id="start-heading" class="text-muted-foreground mb-6 text-sm font-medium">Get started in a minute</h2>
      <ol class="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        {#each steps as step, index (step)}
          <li class="flex gap-3 text-sm">
            <span class="text-muted-foreground font-mono tabular-nums">{index + 1}</span>
            <span>{step}</span>
          </li>
        {/each}
      </ol>
    </section>
  </main>

  <footer class="border-t">
    <div class="text-muted-foreground mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <span>A <a href="https://hackclub.com" target="_blank" rel="noopener" class="hover:text-foreground underline-offset-4 hover:underline">Hack Club</a> project</span>
      <nav class="flex items-center gap-5">
        <a href="https://docs.ai.hackclub.com" target="_blank" rel="noopener" class="hover:text-foreground transition-colors">Docs</a>
        <a href="https://hackclub.com/slack" target="_blank" rel="noopener" class="hover:text-foreground transition-colors">Slack</a>
        <a href="https://github.com/hackclub/ai" target="_blank" rel="noopener" class="hover:text-foreground transition-colors">GitHub</a>
      </nav>
    </div>
  </footer>
</div>
