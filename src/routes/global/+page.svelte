<script lang="ts">
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import StatsGrid from "#lib/components/stats-grid.svelte";

  let { data } = $props();

  const cell = "px-4 py-3 text-sm";
</script>

<svelte:head><title>Global stats</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Global stats" description="Usage across every Hack Club AI user." />

  <section class="mt-10" aria-labelledby="usage-heading">
    <h2 id="usage-heading" class="mb-4 text-sm font-medium">All users</h2>
    <StatsGrid stats={data.globalStats} />
  </section>

  <section class="mt-10" aria-labelledby="models-heading">
    <h2 id="models-heading" class="mb-4 text-sm font-medium">Usage by model</h2>
    {#if data.modelStats.length === 0}
      <EmptyState title="No usage data yet" />
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <thead class="text-muted-foreground border-b text-xs">
            <tr>
              <th class="{cell} font-medium">Model</th>
              <th class="{cell} text-right font-medium">Requests</th>
              <th class="{cell} text-right font-medium">Total tokens</th>
              <th class="{cell} text-right font-medium">Prompt tokens</th>
              <th class="{cell} text-right font-medium">Completion tokens</th>
            </tr>
          </thead>
          <tbody>
            {#each data.modelStats as row (row.model)}
              <tr class="hover:bg-muted/40 border-b last:border-b-0">
                <td class="{cell} max-w-72 truncate font-medium">
                  {#if row.model}<a href="/models/{row.model}" class="hover:underline">{row.model}</a>{:else}Unknown{/if}
                </td>
                <td class="{cell} text-muted-foreground text-right tabular-nums">{row.totalRequests.toLocaleString()}</td>
                <td class="{cell} text-muted-foreground text-right tabular-nums">{row.totalTokens.toLocaleString()}</td>
                <td class="{cell} text-muted-foreground text-right tabular-nums">{row.totalPromptTokens.toLocaleString()}</td>
                <td class="{cell} text-muted-foreground text-right tabular-nums">{row.totalCompletionTokens.toLocaleString()}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>
