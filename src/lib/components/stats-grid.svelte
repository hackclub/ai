<script lang="ts">
  import { formatNumberShort } from "#lib/format.ts";

  let {
    stats,
  }: {
    stats: {
      totalRequests: number;
      totalTokens: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
    };
  } = $props();

  const cards = $derived([
    { label: "Requests", value: stats.totalRequests },
    { label: "Total tokens", value: stats.totalTokens },
    { label: "Prompt tokens", value: stats.totalPromptTokens },
    { label: "Completion tokens", value: stats.totalCompletionTokens },
  ]);
</script>

<dl class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
  {#each cards as card (card.label)}
    <div class="bg-card flex flex-col gap-1 px-4 py-4 sm:px-5">
      <dt class="text-muted-foreground text-xs font-medium">{card.label}</dt>
      <dd class="text-2xl font-semibold tracking-tight tabular-nums" title={card.value.toLocaleString()}>
        <span class="sm:hidden">{formatNumberShort(card.value)}</span>
        <span class="hidden sm:inline">{card.value.toLocaleString()}</span>
      </dd>
    </div>
  {/each}
</dl>
