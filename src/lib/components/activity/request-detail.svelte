<script lang="ts">
  import CopyButton from "#lib/components/copy-button.svelte";
  import * as Sheet from "#lib/components/ui/sheet/index.ts";
  import { Skeleton } from "#lib/components/ui/skeleton/index.ts";
  import { displayModelName, formatDuration, formatFullTime, formatPrice } from "#lib/format.ts";
  import type { ActivityDetail } from "../../../dashboard/read-model";

  let { requestId = $bindable() }: { requestId: string | null } = $props();

  let detail = $state<ActivityDetail | null>(null);
  let failed = $state(false);

  $effect(() => {
    const id = requestId;
    if (!id) return;
    detail = null;
    failed = false;
    const controller = new AbortController();
    fetch(`/activity/requests/${id}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<ActivityDetail>) : Promise.reject()))
      .then(async (loaded) => {
        if (loaded.country) await preloadImage(flagUrl(loaded.country));
        if (!controller.signal.aborted) detail = loaded;
      })
      .catch(() => {
        if (!controller.signal.aborted) failed = true;
      });
    return () => controller.abort();
  });

  // Swapping the skeleton out before the flag has loaded leaves a blank gap where it pops in.
  const preloadImage = (src: string) => {
    const image = new Image();
    image.src = src;
    return Promise.race([image.decode(), new Promise((resolve) => setTimeout(resolve, 500))]).catch(() => {});
  };

  const throughput = (request: ActivityDetail) => {
    const generating = request.durationMs - (request.timeToFirstByteMs ?? 0);
    if (request.outputTokens === 0 || generating <= 0) return null;
    return `${Math.round((request.outputTokens / generating) * 1000).toLocaleString()} tokens/s`;
  };

  const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

  const flagUrl = (country: string) =>
    `https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/svg/${[...country]
      .map((letter) => (0x1f1e6 + letter.charCodeAt(0) - 65).toString(16))
      .join("-")}.svg`;

  const facts = (request: ActivityDetail): [string, string][] =>
    [
      ["Result", request.error ? `Error: ${request.error}` : "Completed"],
      ["HTTP status", String(request.httpStatus)],
      ["Duration", formatDuration(request.durationMs)],
      ["Time to first byte", request.timeToFirstByteMs === null ? null : formatDuration(request.timeToFirstByteMs)],
      ["Throughput", throughput(request)],
      ["Input tokens", request.inputTokens.toLocaleString()],
      ["Output tokens", request.outputTokens.toLocaleString()],
      ["Cost", formatPrice(request.billedCostUsd)],
      ["Provider", request.provider],
      ["Endpoint", request.endpoint],
      ["Streamed", request.streamed ? "Yes" : "No"],
      ["API key", request.apiKeyName],
      ["IP address", request.ip || null],
      ["User agent", request.userAgent || null],
    ].filter((fact): fact is [string, string] => fact[1] !== null);
</script>

<Sheet.Root open={requestId !== null} onOpenChange={(open) => !open && (requestId = null)}>
  <Sheet.Content class="w-full gap-0 overflow-y-auto sm:max-w-md">
    <Sheet.Header class="border-b">
      <Sheet.Title class="pe-8">
        {#if detail}
          {displayModelName(detail.modelName)}{#if detail.variant}<span class="text-muted-foreground font-normal">:{detail.variant}</span>{/if}
        {:else}
          Request
        {/if}
      </Sheet.Title>
      <Sheet.Description>{detail ? formatFullTime(detail.occurredAt) : " "}</Sheet.Description>
    </Sheet.Header>

    <div class="flex flex-col gap-6 p-4">
      {#if failed}
        <p class="text-muted-foreground text-sm">This request could not be loaded.</p>
      {:else if !detail}
        <div class="grid grid-cols-2 gap-3">
          {#each { length: 8 }, index (index)}
            <Skeleton class="h-10" />
          {/each}
        </div>
      {:else}
        <div class="min-w-0">
          <p class="text-muted-foreground text-xs">Request ID</p>
          <CopyButton text={detail.requestId} variant="ghost" class="-ms-2.5 max-w-full text-xs" />
        </div>

        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {#each facts(detail) as [label, value] (label)}
            <div class="min-w-0">
              <dt class="text-muted-foreground text-xs">{label}</dt>
              {#if label === "IP address"}
                <dd class="flex min-w-0 items-center gap-1.5 tabular-nums" title={value}>
                  {#if detail.country}
                    <img
                      src={flagUrl(detail.country)}
                      alt={detail.country}
                      title={regionNames.of(detail.country) ?? detail.country}
                      class="size-4 shrink-0"
                    />
                  {/if}
                  <span class="truncate">{value}</span>
                </dd>
                {#if detail.network}
                  <dd class="text-muted-foreground truncate text-xs" title={detail.network.name}>
                    AS{detail.network.asn} {#if detail.network.name}({detail.network.name}){/if}
                  </dd>
                {/if}
              {:else}
                <dd class="truncate tabular-nums {label === 'Result' && detail.error ? 'text-destructive' : ''}" title={value}>{value}</dd>
              {/if}
            </div>
          {/each}
        </dl>

      {/if}
    </div>

    {#if detail?.network}
      <Sheet.Footer class="text-muted-foreground border-t text-xs">
        <a href="https://db-ip.com" target="_blank" rel="noreferrer" class="hover:text-foreground w-fit underline-offset-4 hover:underline">
          IP Geolocation by DB-IP
        </a>
      </Sheet.Footer>
    {/if}
  </Sheet.Content>
</Sheet.Root>
