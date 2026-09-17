<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, description, children }: { title: string; description?: string; children?: Snippet } = $props();
</script>

<div class="rounded-lg border border-dashed px-6 py-12 text-center">
  <h3 class="font-medium">{title}</h3>
  {#if description}
    <p class="text-muted-foreground mt-1 text-pretty text-base sm:text-sm">{description}</p>
  {/if}
  {#if children}
    <div class="mt-6 flex justify-center">{@render children()}</div>
  {/if}
</div>
