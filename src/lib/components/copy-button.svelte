<script lang="ts">
  import CheckIcon from "remixicon-svelte/icons/check-line";
  import CopyIcon from "remixicon-svelte/icons/file-copy-line";
  import { Button, type ButtonSize, type ButtonVariant } from "#lib/components/ui/button/index.ts";

  let {
    text,
    label = text,
    variant = "outline",
    size = "sm",
    class: className,
  }: { text: string; label?: string; variant?: ButtonVariant; size?: ButtonSize; class?: string } = $props();

  let copied = $state(false);
  const copy = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => (copied = false), 1800);
  };
</script>

<Button {variant} {size} class="font-mono {className ?? ''}" onclick={copy} title="Copy to clipboard">
  {#if copied}
    <CheckIcon data-icon="inline-start" class="size-4 shrink-0 text-primary" />
  {:else}
    <CopyIcon data-icon="inline-start" class="size-4 shrink-0" />
  {/if}
  <span class="truncate">{label}</span>
</Button>
