<script lang="ts">
  import KeyIcon from "remixicon-svelte/icons/key-2-line";
  import CpuIcon from "remixicon-svelte/icons/cpu-line";
  import PulseIcon from "remixicon-svelte/icons/pulse-line";
  import ArrowRightIcon from "remixicon-svelte/icons/arrow-right-s-line";
  import AlertIcon from "remixicon-svelte/icons/alert-line";
  import CloseIcon from "remixicon-svelte/icons/close-line";
  import ExternalIcon from "remixicon-svelte/icons/external-link-line";
  import { Button } from "#lib/components/ui/button/index.ts";
  import CodeBlock from "#lib/components/code-block.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import StatsGrid from "#lib/components/stats-grid.svelte";

  let { data } = $props();

  const user = $derived(data.user!);
  const showIdvBanner = $derived(data.enforceIdv && !user.skipIdv && !user.isIdvVerified);
  let agentBannerDismissed = $state(false);
  const showAgentBanner = $derived(!user.agentBannerDismissed && !agentBannerDismissed);

  const dismissAgentBanner = async () => {
    agentBannerDismissed = true;
    await fetch("/api/dismiss-agent-banner", { method: "POST" });
  };

  const quickLinks = $derived([
    { href: "/keys", title: "API keys", description: "Create and manage the keys your apps authenticate with.", icon: KeyIcon },
    { href: "/models", title: "Models", description: "Browse the available language, image and embedding models.", icon: CpuIcon },
    { href: "/activity", title: "Activity", description: "See your recent requests, token usage and errors.", icon: PulseIcon },
  ]);


  const firstName = $derived(user.name?.split(/\s+/)[0] ?? null);
</script>

<svelte:head><title>Dashboard</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader
    title={firstName ? `Hey, ${firstName}` : "Dashboard"}
    descriptionHtml={`<i>${data.quote}</i>`}
  />

  {#if showIdvBanner}
    <div class="border-destructive/40 bg-destructive/10 mt-8 flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center" role="alert">
      <AlertIcon class="text-destructive size-5 shrink-0" />
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold">Identity verification required</h3>
        <p class="text-muted-foreground mt-1 text-sm text-pretty">
          You must verify your identity to use the API. Requests are currently blocked. Once you're done, sign out and sign back in.
        </p>
      </div>
      <Button href="https://account.hackclub.com" target="_blank" rel="noopener noreferrer" variant="destructive" size="sm" class="shrink-0">
        Verify identity
        <ExternalIcon data-icon="inline-end" class="size-4" />
      </Button>
    </div>
  {/if}

  {#if showAgentBanner}
    <div class="mt-8 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" role="status">
      <AlertIcon class="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold">Not for AI coding agents</h3>
        <p class="text-muted-foreground mt-1 text-sm text-pretty">
          Hack Club AI cannot be used with AI coding agents like OpenClaw, Claude Code, Cursor, Cline, or any other coding agent.
          Requests from these tools will be blocked. Join <code class="font-mono">#hackclub-ai</code> on the Hack Club Slack for updates.
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" class="-m-1 shrink-0" aria-label="Dismiss banner" onclick={dismissAgentBanner}>
        <CloseIcon class="size-4" />
      </Button>
    </div>
  {/if}

  <div class={showIdvBanner ? "pointer-events-none select-none opacity-30 grayscale" : ""}>
    <section class="mt-5" aria-labelledby="usage-heading">
      <h2 id="usage-heading" class="sr-only">Usage</h2>
      <StatsGrid stats={data.stats} />
    </section>

    <section class="mt-10" aria-labelledby="links-heading">
      <h2 id="links-heading" class="mb-4 text-sm font-medium">Jump to</h2>
      <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each quickLinks as link (link.href)}
          <li>
            <a
              href={link.href}
              class="group bg-card hover:bg-muted/60 focus-visible:ring-ring/50 flex h-full items-start gap-3 rounded-lg border p-4 transition-colors outline-none focus-visible:ring-3"
            >
              <span class="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                <link.icon class="size-4" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{link.title}</span>
                <span class="text-muted-foreground mt-1 block text-sm text-pretty">{link.description}</span>
              </span>
              <ArrowRightIcon class="text-muted-foreground group-hover:text-foreground mt-2 size-4 shrink-0 transition-colors" />
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <section class="mt-10" aria-labelledby="quickstart-heading">
      <h2 id="quickstart-heading" class="mb-4 text-sm font-medium">Quickstart</h2>
      <ol class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {#snippet step(number: number, title: string, description: string, body: import("svelte").Snippet)}
          <li class="bg-card flex gap-4 rounded-lg border p-5">
            <span class="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{number}</span>
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium">{title}</h3>
              <p class="text-muted-foreground mt-1 text-sm text-pretty">{description}</p>
              <div class="mt-4">{@render body()}</div>
            </div>
          </li>
        {/snippet}
        {#snippet keyBody()}<Button href="/keys" size="sm" variant="outline">Create an API key</Button>{/snippet}
        {#snippet curlBody()}<CodeBlock code={data.curlExample.code} html={data.curlExample.html} />{/snippet}
        {#snippet modelsBody()}<Button href="/models" size="sm" variant="outline">Browse models</Button>{/snippet}
        {#snippet docsBody()}<Button href="https://docs.ai.hackclub.com" target="_blank" rel="noopener" size="sm" variant="outline">Read the docs<ExternalIcon data-icon="inline-end" class="size-4" /></Button>{/snippet}

        {@render step(1, "Get your API key", "Create a key from the API keys page. Keep it secret and never commit it.", keyBody)}
        {@render step(2, "Make your first request", "Point any OpenAI-compatible client at the proxy, or try curl:", curlBody)}
        {@render step(3, "Explore the models", "Pick from language, image and embedding models to find the right fit.", modelsBody)}
        {@render step(4, "Read the documentation", "Endpoints, parameters and best practices for using the API.", docsBody)}
      </ol>
    </section>
  </div>
</div>
