<script lang="ts">
  import { type CatalogModel, providerName, stripMarkdownLinks } from "#lib/format.ts";
  import CopyButton from "#lib/components/copy-button.svelte";

  let { model }: { model: CatalogModel } = $props();

  const description = $derived(stripMarkdownLinks(model.description ?? ""));
</script>

<a
  href="/models/{model.id}"
  class="group bg-card hover:bg-muted/60 focus-visible:ring-ring/50 flex h-full flex-col gap-3 rounded-lg border p-4 transition-colors outline-none focus-visible:ring-3"
>
  <div class="min-w-0">
    <p class="text-muted-foreground text-xs font-medium">{providerName(model.id)}</p>
    <h3 class="mt-0.5 truncate text-sm font-medium">{model.name || model.id}</h3>
    {#if description}
      <p class="text-muted-foreground mt-1 line-clamp-2 text-sm text-pretty">{description}</p>
    {/if}
  </div>
  <div class="mt-auto">
    <CopyButton text={model.id} size="xs" class="max-w-full" />
  </div>
</a>
