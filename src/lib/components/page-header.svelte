<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    children,
    actions,
  }: { title: string; description?: string; children?: Snippet; actions?: Snippet } = $props();
</script>

<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
  <div class="min-w-0">
    <h1 class="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
    {#if description}
      <p class="text-muted-foreground mt-2 max-w-[62ch] text-pretty text-base sm:text-sm">{description}</p>
    {/if}
    {@render children?.()}
  </div>
  {#if actions}
    <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
  {/if}
</div>
