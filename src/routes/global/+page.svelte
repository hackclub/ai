<script lang="ts">
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { displayModelName, formatDate, formatNumberShort } from "#lib/format.ts";

  let { data } = $props();

  const ranges = [
    { value: "day", label: "24 hours" },
    { value: "week", label: "7 days" },
    { value: "month", label: "30 days" },
    { value: "all", label: "All time" },
  ] as const;

  const tiles = $derived([
    { label: "Requests", value: data.totals.requests },
    { label: "Tokens", value: data.totals.tokens },
    { label: "Active users", value: data.totals.users },
  ]);

  // Series keep their slot for as long as they stay in the top models.
  const colorOf = $derived(
    new Map(data.series.map((series, index) => [series.model, series.model ? `var(--series-${index + 1})` : "var(--series-other)"])),
  );
  const chart = $derived(
    {
      day: { unit: "hour", period: "Last 24 hours" },
      week: { unit: "day", period: "Last 7 days" },
      month: { unit: "day", period: "Last 30 days" },
      all: { unit: "month", period: "All time" },
    }[data.range],
  );
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const barLabel = (start: string) => {
    const date = new Date(start);
    if (chart.unit === "hour") return `${formatDate(date)}, ${String(date.getUTCHours()).padStart(2, "0")}:00`;
    if (chart.unit === "month") return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    return formatDate(date);
  };
  const peak = $derived(Math.max(1, ...data.bars.map((bar) => bar.total)));
  let hovered = $state<number | null>(null);
  let chartWidth = $state(0);
  let anchor = $state({ left: 0, right: 0 });
  const hoveredBar = $derived(hovered === null ? null : data.bars[hovered]);

  const percent = (share: number) => (share < 0.001 ? "<0.1%" : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`);
  const cell = "px-4 py-3 text-sm";
</script>

<svelte:head><title>Global stats</title></svelte:head>

<div class="viz mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Global stats">
    {#snippet actions()}
      <nav class="bg-muted flex rounded-lg p-0.5 text-sm" aria-label="Time range">
        {#each ranges as range (range.value)}
          <a
            href="?range={range.value}"
            data-sveltekit-noscroll
            aria-current={data.range === range.value ? "page" : undefined}
            class="text-muted-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground rounded-md px-2.5 py-1 font-medium whitespace-nowrap transition-colors aria-[current=page]:shadow-xs"
          >{range.label}</a>
        {/each}
      </nav>
    {/snippet}
  </PageHeader>

  <dl class="bg-border mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-lg border">
    {#each tiles as tile (tile.label)}
      <div class="bg-card flex flex-col gap-1 px-4 py-4 sm:px-5">
        <dt class="text-muted-foreground text-xs font-medium">{tile.label}</dt>
        <dd class="text-2xl font-semibold tracking-tight tabular-nums" title={tile.value.toLocaleString()}>
          {formatNumberShort(tile.value)}
        </dd>
      </div>
    {/each}
  </dl>

  <section class="bg-card mt-6 rounded-lg border p-4 sm:p-5" aria-labelledby="daily-heading">
    <div class="flex items-baseline justify-between gap-4">
      <h2 id="daily-heading" class="text-sm font-medium">Tokens per {chart.unit}</h2>
      <p class="text-muted-foreground text-xs">{chart.period}, UTC</p>
    </div>
    {#if data.series.length === 0}
      <p class="text-muted-foreground py-16 text-center text-sm">No usage in this period.</p>
    {:else}
      <div class="relative mt-4" bind:clientWidth={chartWidth}>
        <div class="text-muted-foreground pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 text-xs tabular-nums">
          <span>{formatNumberShort(peak)}</span>
          <span class="border-border flex-1 border-t border-dashed"></span>
        </div>
        <div class="flex h-48 items-end gap-0.5 pt-5 sm:gap-1" role="img" aria-label="Stacked bar chart of tokens per {chart.unit} by model">
          {#each data.bars as bar, index (bar.start)}
            <div
              class="flex h-full flex-1 flex-col-reverse gap-[2px] {hovered !== null && hovered !== index ? 'opacity-50' : ''}"
              onpointerenter={(event) => {
                hovered = index;
                anchor = { left: event.currentTarget.offsetLeft, right: event.currentTarget.offsetLeft + event.currentTarget.offsetWidth };
              }}
              onpointerleave={() => (hovered = null)}
              role="presentation"
            >
              {#each data.series as series (series.model)}
                {@const tokens = bar.tokens[series.model] ?? 0}
                {#if tokens > 0}
                  <div
                    class="min-h-px w-full last:rounded-t-[4px]"
                    style="height: {(tokens / peak) * 100}%; background: {colorOf.get(series.model)}"
                  ></div>
                {/if}
              {/each}
            </div>
          {/each}
        </div>
        {#if hoveredBar && hovered !== null}
          <div
            class="bg-popover text-popover-foreground pointer-events-none absolute top-0 z-10 w-56 rounded-md border p-3 text-xs shadow-md"
            style={anchor.left < chartWidth / 2 ? `left: ${anchor.right + 8}px` : `right: ${chartWidth - anchor.left + 8}px`}
          >
            <p class="font-medium">{barLabel(hoveredBar.start)}</p>
            <p class="text-muted-foreground mb-2 tabular-nums">{hoveredBar.total.toLocaleString()} tokens</p>
            <ul class="space-y-1">
              {#each data.series.filter((series) => hoveredBar.tokens[series.model]) as series (series.model)}
                <li class="flex items-center gap-2">
                  <span class="size-2 shrink-0 rounded-[2px]" style="background: {colorOf.get(series.model)}"></span>
                  <span class="truncate">{displayModelName(series.name)}</span>
                  <span class="text-muted-foreground ms-auto tabular-nums">{formatNumberShort(hoveredBar.tokens[series.model] ?? 0)}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <div class="text-muted-foreground mt-2 flex justify-between text-xs">
          <span>{data.bars[0] ? barLabel(data.bars[0].start) : ""}</span>
          <span>{data.bars.at(-1) ? barLabel(data.bars.at(-1)!.start) : ""}</span>
        </div>
      </div>
      <ul class="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Legend">
        {#each data.series as series (series.model)}
          <li class="flex items-center gap-1.5">
            <span class="size-2.5 rounded-[2px]" style="background: {colorOf.get(series.model)}"></span>
            {displayModelName(series.name)}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <div class="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
    <section aria-labelledby="models-heading">
      <h2 id="models-heading" class="mb-4 text-sm font-medium">Top models</h2>
      {#if data.models.length === 0}
        <EmptyState title="No usage in this period" />
      {:else}
        <div class="overflow-x-auto rounded-lg border">
          <table class="w-full border-collapse text-left">
            <thead class="text-muted-foreground border-b text-xs">
              <tr>
                <th class="{cell} w-10 font-medium">#</th>
                <th class="{cell} font-medium">Model</th>
                <th class="{cell} text-right font-medium">Tokens</th>
                <th class="{cell} hidden text-right font-medium sm:table-cell">Requests</th>
              </tr>
            </thead>
            <tbody>
              {#each data.models as row, index (row.model)}
                <tr class="hover:bg-muted/40 border-b last:border-b-0">
                  <td class="{cell} text-muted-foreground tabular-nums">{index + 1}</td>
                  <td class="{cell} max-w-72">
                    <div class="truncate font-medium">
                      {#if row.href}<a href={row.href} class="hover:underline">{displayModelName(row.name)}</a>{:else}{displayModelName(row.name)}{/if}
                    </div>
                    <div class="text-muted-foreground truncate text-xs">{row.model}</div>
                  </td>
                  <td class="{cell} text-right whitespace-nowrap tabular-nums">
                    {formatNumberShort(row.tokens)}
                    <span class="text-muted-foreground ms-1 text-xs">{percent(row.share)}</span>
                  </td>
                  <td class="{cell} text-muted-foreground hidden text-right tabular-nums sm:table-cell">{row.requests.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section aria-labelledby="authors-heading">
      <h2 id="authors-heading" class="mb-4 text-sm font-medium">Top authors</h2>
      {#if data.authors.length > 0}
        <ul class="bg-card space-y-3 rounded-lg border p-4">
          {#each data.authors as row (row.author)}
            <li>
              <div class="flex items-baseline justify-between gap-2 text-sm">
                <span class="truncate font-medium">{row.author}</span>
                <span class="text-muted-foreground text-xs tabular-nums">{percent(row.share)}</span>
              </div>
              <div class="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full">
                <div class="bg-primary h-full rounded-full" style="width: {row.share * 100}%"></div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .viz {
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --series-3: #1baf7a;
    --series-4: #eda100;
    --series-5: #e87ba4;
    --series-6: #008300;
    --series-7: #4a3aa7;
    --series-8: #e34948;
    --series-other: #c3c2b7;
  }
  :global(.dark) .viz {
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --series-7: #9085e9;
    --series-8: #e66767;
    --series-other: #52514e;
  }
</style>
