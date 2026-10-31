<script lang="ts">
  import KeyIcon from "remixicon-svelte/icons/key-2-line";
  import CpuIcon from "remixicon-svelte/icons/cpu-line";
  import PulseIcon from "remixicon-svelte/icons/pulse-line";
  import ArrowRightIcon from "remixicon-svelte/icons/arrow-right-s-line";
  import AlertIcon from "remixicon-svelte/icons/alert-line";
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

  const AGENT_NOTICE_SECONDS = 5;
  let secondsLeft = $state(AGENT_NOTICE_SECONDS);
  $effect(() => {
    if (!showAgentBanner) return;
    const timer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  });

  let playerTwoBannerDismissed = $state(false);
  const showPlayerTwoBanner = $derived(!data.playerTwoBannerDismissed && !playerTwoBannerDismissed);

  const dismissPlayerTwoBanner = () => {
    playerTwoBannerDismissed = true;
    document.cookie = "playertwo_banner_dismissed=1; path=/dashboard; max-age=31536000; samesite=lax";
  };

  const dismissAgentBanner = async () => {
    if (secondsLeft > 0) return;
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

  <div class={showIdvBanner ? "pointer-events-none select-none opacity-30 grayscale" : ""}>
    <section class="mt-5" aria-labelledby="usage-heading">
      <h2 id="usage-heading" class="sr-only">Usage</h2>
      <StatsGrid stats={data.stats} />
    </section>

    {#if showPlayerTwoBanner}
      <aside class="@container relative mt-3 overflow-hidden rounded-lg border border-white/10 bg-[#1a1e24] text-white" aria-label="Player Two">
        <a
          href="https://playertwo.hackclub.com/?ref=hackclub-ai-banner"
          target="_blank"
          rel="noopener"
          class="group focus-visible:ring-ring/50 flex min-h-16 items-center gap-3 rounded-lg py-2 pr-11 pl-4 outline-none focus-visible:ring-3 @md:gap-4 @2xl:pr-72"
        >
          <img src="/playertwo/logo.webp" alt="Player Two" width="247" height="128" class="h-8 w-auto shrink-0 @md:h-10" />
          <span class="min-w-0 text-xs leading-snug text-pretty @md:text-sm">
            Train an AI model that can play a game, get <strong class="font-semibold whitespace-nowrap">free co-op games!</strong>
          </span>
          <img
            src="/playertwo/games.webp"
            alt=""
            width="458"
            height="176"
            class="pointer-events-none absolute top-1 right-10 hidden h-22 w-auto transition-transform group-hover:-translate-y-0.5 @2xl:block"
          />
        </a>
        <button
          type="button"
          class="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-3 focus-visible:ring-white/40 outline-none"
          aria-label="Dismiss Player Two banner"
          onclick={dismissPlayerTwoBanner}
        >
          <CloseIcon class="size-4" />
        </button>
      </aside>
    {/if}

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

{#if showAgentBanner}
  <div
    class="bg-background/95 fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-6 backdrop-blur-sm"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="agent-notice-title"
    aria-describedby="agent-notice-body"
  >
    <div class="w-full max-w-2xl rounded-2xl border-2 border-red-500/60 bg-red-500/10 p-8 sm:p-12">
      <AlertIcon class="size-16 text-red-600 dark:text-red-400" />
      <h2 id="agent-notice-title" class="mt-6 text-4xl font-bold tracking-tight text-balance sm:text-5xl">
        AI coding agents are NOT allowed
      </h2>
      <div id="agent-notice-body" class="mt-6 space-y-4 text-lg text-pretty">
        <p>
          Do <strong>not</strong> use Hack Club AI with coding agents like OpenClaw, Claude Code, Cursor, Cline, Codex, OpenCode or any
          other coding agent. Requests from these tools are blocked, and your account can be banned.
        </p>
        <p class="text-muted-foreground">
          General agents are fine, as long as <strong>you code them yourself</strong>: your own bot, your own tools, your own loop.
          Just don't point a ready-made coding agent at this API.
        </p>
        <p class="text-muted-foreground">
          Questions? Join <code class="font-mono">#hackclub-ai</code> on the Hack Club Slack.
        </p>
      </div>
      <Button size="lg" class="mt-8 w-full sm:w-auto" disabled={secondsLeft > 0} onclick={dismissAgentBanner}>
        {secondsLeft > 0 ? `I understand (${secondsLeft})` : "I understand"}
      </Button>
    </div>
  </div>
{/if}
