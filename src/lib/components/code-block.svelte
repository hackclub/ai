<script lang="ts">
  import CheckIcon from "remixicon-svelte/icons/check-line";
  import CopyIcon from "remixicon-svelte/icons/file-copy-line";
  import { Button } from "#lib/components/ui/button/index.ts";


  let { code, html }: { code: string; html?: string } = $props();

  let copied = $state(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    copied = true;
    setTimeout(() => (copied = false), 1800);
  };
</script>

<div class="code-block bg-muted/50 relative min-w-0 overflow-hidden rounded-md border">
  <Button variant="ghost" size="icon-sm" class="absolute top-2 right-2 z-10" onclick={copy} aria-label="Copy code">
    {#if copied}<CheckIcon class="text-primary size-4" />{:else}<CopyIcon class="size-4" />{/if}
  </Button>
  {#if html}
    {@html html}
  {:else}
    <pre class="overflow-x-auto p-4 pr-12 font-mono text-sm"><code class="whitespace-pre">{code}</code></pre>
  {/if}
</div>
