<script lang="ts">
  let { spending }: { spending: { spentUsd: string; limitUsd: string } } = $props();

  const spent = $derived(Number.parseFloat(spending.spentUsd || "0"));
  const limit = $derived(Number.parseFloat(spending.limitUsd || "0"));
  const ratio = $derived(limit > 0 ? Math.min(spent / limit, 1) : 0);
  const tone = $derived(ratio >= 0.9 ? "bg-destructive" : ratio >= 0.6 ? "bg-amber-500" : "bg-primary");
</script>

<div
  class="border-border bg-muted/40 text-muted-foreground hidden items-center gap-2 rounded-full border px-2.5 py-1 text-xs tabular-nums sm:flex"
  title="Spent today against your daily limit"
>
  <span class="size-2 rounded-full {tone}"></span>
  <span><span class="text-foreground font-medium">${spent.toFixed(2)}</span> / ${limit.toFixed(2)} today</span>
</div>
