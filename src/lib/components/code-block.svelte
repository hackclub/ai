<script lang="ts">
  import CheckIcon from "remixicon-svelte/icons/check-line";
  import CopyIcon from "remixicon-svelte/icons/file-copy-line";
  import { Button } from "#lib/components/ui/button/index.ts";

  let { code }: { code: string } = $props();

  let copied = $state(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    copied = true;
    setTimeout(() => (copied = false), 1800);
  };
</script>

<div class="relative">
  <Button variant="ghost" size="icon-sm" class="absolute top-2 right-2" onclick={copy} aria-label="Copy code">
    {#if copied}<CheckIcon class="text-primary size-4" />{:else}<CopyIcon class="size-4" />{/if}
  </Button>
  <pre class="bg-muted/50 overflow-x-auto rounded-md border p-4 pr-12 text-sm"><code class="font-mono whitespace-pre">{code}</code></pre>
</div>
