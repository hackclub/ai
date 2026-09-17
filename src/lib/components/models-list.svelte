<script lang="ts">
  import ArrowDownIcon from "remixicon-svelte/icons/arrow-down-s-line";
  import { Button } from "#lib/components/ui/button/index.ts";
  import ModelCard from "#lib/components/model-card.svelte";
  import type { CatalogModel } from "#lib/format.ts";

  let { title, models }: { title: string; models: CatalogModel[] } = $props();

  const PREVIEW = 6;
  let expanded = $state(false);
  const visible = $derived(expanded || models.length <= PREVIEW ? models : models.slice(0, PREVIEW));
</script>

<section class="mt-10" aria-label={title}>
  <div class="mb-4 flex items-center justify-between gap-4">
    <h2 class="text-sm font-medium">{title} <span class="text-muted-foreground font-normal tabular-nums">({models.length})</span></h2>
    {#if models.length > PREVIEW}
      <Button variant="ghost" size="sm" onclick={() => (expanded = !expanded)}>
        {expanded ? "Show less" : `Show all ${models.length}`}
        <ArrowDownIcon data-icon="inline-end" class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
      </Button>
    {/if}
  </div>
  {#if models.length === 0}
    <p class="text-muted-foreground text-sm">No models available right now.</p>
  {:else}
    <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each visible as model (model.id)}
        <li><ModelCard {model} /></li>
      {/each}
    </ul>
  {/if}
</section>
