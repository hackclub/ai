<script lang="ts">
  import ArrowRightIcon from "remixicon-svelte/icons/arrow-right-line";
  import { Button } from "#lib/components/ui/button/index.ts";
  import DarkModeToggle from "#lib/components/layout/dark-mode-toggle.svelte";

  let { data } = $props();

  const features = [
    {
      title: "OpenAI compatible",
      body: "Works with any SDK, library or tool. Just swap your base URL.",
      code: 'base_url = "https://ai.hackclub.com/proxy/v1"',
    },
    { title: "100% free", body: "No credit card, no catch. Sign in with your Hack Club account and start building." },
    { title: "30+ models", body: "Gemini, GPT, Kimi K2, GLM and many more, plus image and embedding models." },
    { title: "Web search", body: "Search, answer questions and fetch live web content through Exa." },
  ];

  const featured = $derived(data.models.slice(0, 12));
</script>

<svelte:head><title>Hack Club AI</title></svelte:head>

<div class="flex min-h-svh flex-col">
  <header class="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
    <a href="/" class="flex items-center gap-2 font-semibold">
      <span class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg text-base font-bold">h</span>
      Hack Club AI
    </a>
    <div class="flex items-center gap-2">
      <Button href="https://docs.ai.hackclub.com" target="_blank" rel="noopener" variant="ghost" size="sm">Docs</Button>
      <DarkModeToggle />
    </div>
  </header>

  <main class="flex-1">
    <section class="mx-auto w-full max-w-5xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24 lg:px-8">
      <div class="max-w-2xl">
        <h1 class="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">Free AI access for Hack Clubbers.</h1>
        <p class="text-muted-foreground mt-4 max-w-[60ch] text-pretty text-lg">
          Use Gemini, GPT, Kimi K2 and 30+ other models through an OpenAI-compatible API. Build projects, learn and experiment, for free.
        </p>
        <div class="mt-8 flex flex-wrap items-center gap-3">
          <Button href="/auth/login" data-sveltekit-reload size="lg" class="h-12 px-5">
            Sign in with Hack Club
            <ArrowRightIcon data-icon="inline-end" class="size-4" />
          </Button>
          <p class="text-muted-foreground text-sm">DM @mahad on Slack for support.</p>
        </div>
      </div>
    </section>

    <section class="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8" aria-label="Features">
      <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {#each features as feature (feature.title)}
          <li class="bg-card flex flex-col rounded-lg border p-5">
            <h2 class="text-sm font-medium">{feature.title}</h2>
            <p class="text-muted-foreground mt-1 text-sm text-pretty">{feature.body}</p>
            {#if feature.code}
              <code class="bg-muted mt-4 block overflow-x-auto rounded-md px-3 py-2 font-mono text-xs whitespace-nowrap">{feature.code}</code>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    {#if featured.length > 0}
      <section class="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8" aria-labelledby="featured-heading">
        <h2 id="featured-heading" class="mb-4 text-sm font-medium">Featured models</h2>
        <ul role="list" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {#each featured as model (model)}
            {@const [provider, ...nameParts] = model.split("/")}
            <li class="bg-card rounded-lg border px-4 py-3">
              <p class="text-muted-foreground text-xs font-medium">{provider}</p>
              <p class="mt-0.5 truncate text-sm font-medium">{nameParts.join("/").split(":")[0]}</p>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </main>

  <footer class="border-t">
    <div class="text-muted-foreground mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <span>&copy; 2025–2026 Hack Club</span>
      <nav class="flex items-center gap-5">
        <a href="https://hackclub.com" target="_blank" rel="noopener" class="hover:text-foreground transition-colors">Hack Club</a>
        <a href="https://hackclub.com/slack" target="_blank" rel="noopener" class="hover:text-foreground transition-colors">Slack</a>
        <a href="https://github.com/hackclub/ai" target="_blank" rel="noopener" class="hover:text-foreground transition-colors">GitHub</a>
      </nav>
    </div>
  </footer>
</div>
