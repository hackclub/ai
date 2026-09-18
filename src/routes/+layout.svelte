<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { page } from "$app/state";
  import notoSansLatin from "@fontsource-variable/noto-sans/files/noto-sans-latin-wght-normal.woff2?url";
  import * as Sidebar from "#lib/components/ui/sidebar/index.ts";
  import AppSidebar from "#lib/components/layout/app-sidebar.svelte";
  import DarkModeToggle from "#lib/components/layout/dark-mode-toggle.svelte";
  import SpendingBadge from "#lib/components/layout/spending-badge.svelte";

  let { data, children } = $props();

  // The sidebar shell wraps every signed-in page except the marketing home page.
  const showShell = $derived(data.user !== null && page.url.pathname !== "/");

  const titles: [string, string][] = [
    ["/dashboard", "Dashboard"],
    ["/keys", "API keys"],
    ["/models", "Models"],
    ["/activity", "Activity"],
    ["/replicate", "Replicate"],
    ["/jev", "Jev"],
    ["/ocr", "OCR"],
    ["/exa", "Exa"],
    ["/global", "Global stats"],
  ];
  const sectionTitle = $derived(
    titles.find(([prefix]) => page.url.pathname === prefix || page.url.pathname.startsWith(`${prefix}/`))?.[1] ?? "Hack Club AI",
  );
</script>

<svelte:head>
  <link rel="preload" href={notoSansLatin} as="font" type="font/woff2" crossorigin="anonymous" />
</svelte:head>

<ModeWatcher />

{#snippet devBanner()}
  {#if data.devMode}
    <div class="bg-amber-500/15 text-amber-950 dark:text-amber-200 border-b border-amber-500/30 px-4 py-1.5 text-center text-xs font-medium">
      You're in dev mode, go wild!
    </div>
  {/if}
{/snippet}

{#if showShell && data.user}
  <Sidebar.Provider>
    <AppSidebar user={data.user} />
    <main class="isolate flex min-w-0 flex-1 flex-col">
      {@render devBanner()}
      <header class="flex h-14 items-center gap-3 border-b px-4 sm:px-6">
        <Sidebar.Trigger />
        <span class="text-sm font-medium">{sectionTitle}</span>
        <div class="ms-auto flex items-center gap-2">
          {#if data.spending}
            <SpendingBadge spending={data.spending} />
          {/if}
          <DarkModeToggle />
        </div>
      </header>
      {@render children()}
    </main>
  </Sidebar.Provider>
{:else}
  {@render devBanner()}
  {@render children()}
{/if}
