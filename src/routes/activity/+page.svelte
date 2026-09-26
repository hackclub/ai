<script lang="ts">
  import SearchIcon from "remixicon-svelte/icons/search-line";
  import { goto } from "$app/navigation";
  import { navigating } from "$app/state";
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import RequestDetail from "#lib/components/activity/request-detail.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { displayModelName, formatDuration, formatFullTime, formatPrice, formatRelativeTime, hashColor } from "#lib/format.ts";
  import type { ActivityPage } from "../../dashboard/read-model";

  let { data } = $props();

  let rows = $derived(data.recent.rows);
  let next = $derived(data.recent.next);
  let loading = $state(false);

  let search = $derived(data.filters.search ?? "");
  let status = $derived(data.filters.status ?? "");
  let key = $derived(data.filters.apiKeyId ?? "");
  let model = $derived(data.filters.model ?? "");

  let selectedId = $state<string | null>(null);

  const filterParams = () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (status) params.set("status", status);
    if (key) params.set("key", key);
    if (model) params.set("model", model);
    return params;
  };

  const applyFilters = () => {
    const query = filterParams().toString();
    goto(query ? `?${query}` : "/activity", { reset: false, replace: true });
  };

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const onSearch = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 300);
  };

  const clearFilters = () => {
    search = "";
    status = "";
    key = "";
    model = "";
    applyFilters();
  };

  const filtered = $derived(Object.keys(data.filters).length > 0);

  const loadMore = async () => {
    if (!next || loading) return;
    loading = true;
    try {
      const params = filterParams();
      params.set("before", next.before);
      params.set("beforeId", next.beforeId);
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
  const select =
    "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-md border bg-transparent py-1 ps-2.5 pe-8 text-base shadow-xs outline-none focus-visible:ring-3 md:text-sm";
</script>

<svelte:head><title>Activity</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Activity" />

  <section class="mt-10" aria-labelledby="requests-heading">
    <h2 id="requests-heading" class="sr-only">Requests</h2>
    <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <div class="relative flex-1 sm:min-w-64">
        <SearchIcon class="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
        <Input
          type="search"
          placeholder="Search models, errors or request IDs"
          aria-label="Search requests"
          class="ps-8"
          bind:value={search}
          oninput={onSearch}
        />
      </div>
      <select class={select} aria-label="Result" bind:value={status} onchange={applyFilters}>
        <option value="">All results</option>
        <option value="ok">Successful</option>
        <option value="error">Errors</option>
      </select>
      <select class={select} aria-label="API key" bind:value={key} onchange={applyFilters}>
        <option value="">All keys</option>
        {#each data.options.keys as option (option.id)}
          <option value={option.id}>{option.name}</option>
        {/each}
      </select>
      <select class="{select} sm:max-w-56" aria-label="Model" bind:value={model} onchange={applyFilters}>
        <option value="">All models</option>
        {#each data.options.models as option (option.id)}
          <option value={option.id}>{displayModelName(option.name)}</option>
        {/each}
      </select>
    </div>

    {#if rows.length === 0}
      {#if filtered}
        <EmptyState title="No matching requests" description="Try a different search or clear the filters.">
          <Button variant="outline" size="sm" onclick={clearFilters}>Clear filters</Button>
        </EmptyState>
      {:else}
        <EmptyState title="No requests... yet" description="Requests made with one of your API keys will show up here." />
      {/if}
    {:else}
      <div class="overflow-x-auto rounded-lg border transition-opacity {navigating.to ? 'opacity-60' : ''}">
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
              <tr
                class="hover:bg-muted/40 focus-visible:bg-muted/40 cursor-pointer border-b outline-none last:border-b-0"
                tabindex="0"
                aria-label="Show request details"
                onclick={() => (selectedId = row.requestId)}
                onkeydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectedId = row.requestId;
                  }
                }}
              >
                <td class="{cell} whitespace-nowrap">
                  <abbr class="no-underline" title={formatFullTime(row.occurredAt)}>{formatRelativeTime(row.occurredAt)}</abbr>
                  <abbr
                    class="ms-1 cursor-help no-underline"
                    title={`Key: ${row.apiKeyName}\nIP: ${row.ip || "unknown"}`}
                    style="color: {hashColor(`${row.apiKeyName}:${row.ip}`)}"
                  >●</abbr>
                </td>
                <td class="{cell} max-w-64 truncate font-medium">
                  {#if row.modelHref}
                    <a href={row.modelHref} class="hover:underline" onclick={(event) => event.stopPropagation()}>{displayModelName(row.modelName)}</a>
                  {:else}
                    {displayModelName(row.modelName)}
                  {/if}
                  {#if row.variant}
                    <span class="text-muted-foreground bg-muted ms-1 rounded px-1.5 py-0.5 text-xs font-normal">{row.variant}</span>
                  {/if}
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

<RequestDetail bind:requestId={selectedId} />
