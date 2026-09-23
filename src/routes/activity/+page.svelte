<script lang="ts">
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { displayModelName, formatDuration, formatFullTime, formatPrice, formatRelativeTime, hashColor } from "#lib/format.ts";
  import type { ActivityPage, ActivityRow } from "../../dashboard/read-model";

  let { data } = $props();

  let rows = $state<ActivityRow[]>([]);
  let next = $state<ActivityPage["next"]>(null);
  let loading = $state(false);

  $effect(() => {
    rows = data.recent.rows;
    next = data.recent.next;
  });

  const loadMore = async () => {
    if (!next || loading) return;
    loading = true;
    try {
      const params = new URLSearchParams({ before: next.before, beforeId: next.beforeId });
      const response = await fetch(`/activity/requests?${params}`);
      if (!response.ok) return;
      const page = (await response.json()) as ActivityPage;
      rows = [...rows, ...page.rows];
      next = page.next;
    } finally {
      loading = false;
    }
  };

  const cell = "px-4 py-3 text-sm";
</script>

<svelte:head><title>Activity</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Activity" />

  <section class="mt-10" aria-labelledby="requests-heading">
    <h2 id="requests-heading" class="mb-4 text-sm font-medium">Recent requests</h2>
    {#if rows.length === 0}
      <EmptyState title="No requests... yet" description="Requests made with one of your API keys will show up here." />
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <thead class="text-muted-foreground border-b text-xs">
            <tr>
              <th class="{cell} font-medium">Time</th>
              <th class="{cell} font-medium">Model</th>
              <th class="{cell} font-medium">Tokens</th>
              <th class="{cell} font-medium">Cost</th>
              <th class="{cell} font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.requestId)}
              <tr class="hover:bg-muted/40 border-b last:border-b-0">
                <td class="{cell} whitespace-nowrap">
                  <abbr class="no-underline" title={formatFullTime(row.occurredAt)}>{formatRelativeTime(row.occurredAt)}</abbr>
                  <abbr
                    class="ms-1 cursor-help no-underline"
                    title={`Key: ${row.apiKeyName}\nIP: ${row.ip || "unknown"}`}
                    style="color: {hashColor(`${row.apiKeyName}:${row.ip}`)}"
                  >●</abbr>
                </td>
                <td class="{cell} max-w-64 truncate font-medium">
                  <a href="/models/{row.model}" class="hover:underline">{displayModelName(row.modelName)}</a>
                </td>
                <td class="{cell} text-muted-foreground whitespace-nowrap tabular-nums">
                  {#if row.error}
                    <span>No usage</span>
                  {:else}
                    {row.inputTokens.toLocaleString()} in / {row.outputTokens.toLocaleString()} out
                  {/if}
                </td>
                <td class="{cell} text-muted-foreground whitespace-nowrap tabular-nums">
                  {row.error ? "–" : formatPrice(row.billedCostUsd)}
                </td>
                <td class="{cell} whitespace-nowrap">
                  <abbr class="no-underline font-medium {row.error ? 'text-destructive' : 'text-primary'}" title={row.error || "Request completed"}>
                    {row.error ? "Error" : "OK"}
                  </abbr>
                  <span class="text-muted-foreground ms-1 tabular-nums">{formatDuration(row.durationMs)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if next}
        <div class="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onclick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more requests"}
          </Button>
        </div>
      {/if}
    {/if}
  </section>
</div>
