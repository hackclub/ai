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

  const escapes: Record<string, string> = {
    "<": "\\u003c",
    ">": "\\u003e",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };
  // Escapes characters that could break out of an inline script tag.
  const jsonForScript = (value: unknown) =>
    JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) => escapes[character] ?? character);

  const posthogSnippet = $derived(
    data.posthog
      ? `!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(${jsonForScript(data.posthog.apiKey)}, { api_host: ${jsonForScript(data.posthog.apiHost)}, ui_host: ${jsonForScript(data.posthog.uiHost)}, defaults: '2025-11-30', person_profiles: 'identified_only' });
${
  data.user
    ? `posthog.identify(${jsonForScript(data.user.slackId)}, { userId: ${jsonForScript(data.user.id)}, email: ${jsonForScript(data.user.email)}, name: ${jsonForScript(data.user.name)}, isIdvVerified: ${data.user.isIdvVerified ? "true" : "false"} });`
    : ""
}`
      : null,
  );

  // The sidebar shell wraps every signed-in page except the marketing home page.
  const showShell = $derived(data.user !== null && page.url.pathname !== "/");

  const titles: [string, string][] = [
    ["/dashboard", "Dashboard"],
    ["/keys", "API keys"],
    ["/models", "Models"],
    ["/activity", "Activity"],
    ["/replicate", "Replicate"],
    ["/global", "Global stats"],
  ];
  const sectionTitle = $derived(
    titles.find(([prefix]) => page.url.pathname === prefix || page.url.pathname.startsWith(`${prefix}/`))?.[1] ?? "Hack Club AI",
  );
</script>

<svelte:head>
  <link rel="preload" href={notoSansLatin} as="font" type="font/woff2" crossorigin="anonymous" />
  {#if posthogSnippet}
    <!-- Assembled from pieces so Vite's dependency scanner does not parse
         the template text as an inline module. -->
    {@html `<${"script"}>${posthogSnippet}</${"script"}>`}
  {/if}
</svelte:head>

<ModeWatcher />

{#if showShell && data.user}
  <Sidebar.Provider>
    <AppSidebar user={data.user} replicateEnabled={data.replicateEnabled} />
    <main class="isolate flex min-w-0 flex-1 flex-col">
      {#if data.devMode}
        <div class="bg-amber-500/15 text-amber-950 dark:text-amber-200 border-b border-amber-500/30 px-4 py-1.5 text-center text-xs font-medium">
          🛠️ You're in dev mode, go wild!
        </div>
      {/if}
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
  {#if data.devMode}
    <div class="bg-amber-500/15 text-amber-950 dark:text-amber-200 border-b border-amber-500/30 px-4 py-1.5 text-center text-xs font-medium">
      🛠️ You're in dev mode, go wild!
    </div>
  {/if}
  {@render children()}
{/if}
