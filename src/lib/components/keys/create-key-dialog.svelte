<script lang="ts">
  import confetti from "canvas-confetti";
  import CheckIcon from "remixicon-svelte/icons/check-line";
  import CopyIcon from "remixicon-svelte/icons/file-copy-line";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import CodeBlock from "#lib/components/code-block.svelte";

  let {
    baseUrl,
    featuredModel,
    oncreate,
  }: { baseUrl: string; featuredModel: string; oncreate: () => void | Promise<void> } = $props();

  let open = $state(false);
  let keyName = $state("");
  let createdSecret = $state<string | null>(null);
  let errorMessage = $state("");
  let busy = $state(false);
  let copied = $state(false);
  let emphasizeDone = $state(false);
  let emphasizeDoneTimeout: ReturnType<typeof setTimeout> | undefined;

  export function show() {
    keyName = "";
    createdSecret = null;
    errorMessage = "";
    copied = false;
    emphasizeDone = false;
    open = true;
  }

  function cueDoneButton() {
    emphasizeDone = false;
    if (emphasizeDoneTimeout) clearTimeout(emphasizeDoneTimeout);
    requestAnimationFrame(() => {
      emphasizeDone = true;
      emphasizeDoneTimeout = setTimeout(() => (emphasizeDone = false), 500);
    });
  }

  // Once the secret is on screen, an accidental dismissal would lose it.
  function preventRevealDismiss(event: Event) {
    if (!createdSecret) return;
    event.preventDefault();
    cueDoneButton();
  }

  async function createKey(event: SubmitEvent) {
    event.preventDefault();
    const name = keyName.trim();
    if (!name || busy) return;
    busy = true;
    errorMessage = "";
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await response.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!response.ok || !body.key) {
        errorMessage = body.error ?? "Could not create the key.";
        return;
      }
      createdSecret = body.key;
      keyName = "";
      await oncreate();
      requestAnimationFrame(() => {
        void confetti({
          particleCount: 80,
          spread: 70,
          startVelocity: 35,
          origin: { x: 0.5, y: 0.5 },
          disableForReducedMotion: true,
        });
      });
    } finally {
      busy = false;
    }
  }

  async function copySecret() {
    if (!createdSecret) return;
    await navigator.clipboard.writeText(createdSecret);
    copied = true;
    setTimeout(() => (copied = false), 1800);
  }

  const example = $derived(
    `curl ${baseUrl}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer ${createdSecret ?? "YOUR_API_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${featuredModel}", "messages": [{"role": "user", "content": "Hi"}]}'`,
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="sm:max-w-xl"
    showCloseButton={!createdSecret}
    onInteractOutside={preventRevealDismiss}
    onEscapeKeydown={preventRevealDismiss}
  >
    {#if createdSecret}
      <Dialog.Header>
        <Dialog.Title>Your new key is ready</Dialog.Title>
        <Dialog.Description>
          Copy it now. You will not be able to see it again. Don't share it or commit it to a public repo.
        </Dialog.Description>
      </Dialog.Header>

      <code class="bg-muted border-border min-w-0 overflow-x-auto rounded-md border px-3 py-2.5 font-mono text-sm whitespace-nowrap">{createdSecret}</code>

      <div class="mt-2">
        <p class="text-muted-foreground mb-2 text-xs font-medium">Example request</p>
        <CodeBlock code={example} />
      </div>

      <Dialog.Footer>
        <Button class={emphasizeDone ? "done-attention" : undefined} variant="outline" size="sm" onclick={() => (open = false)}>Done</Button>
        <Button size="sm" onclick={copySecret}>
          {#if copied}
            <CheckIcon data-icon="inline-start" class="size-4 shrink-0" />
            Copied
          {:else}
            <CopyIcon data-icon="inline-start" class="size-4 shrink-0" />
            Copy key
          {/if}
        </Button>
      </Dialog.Footer>
    {:else}
      <form onsubmit={createKey}>
        <Dialog.Header>
          <Dialog.Title>Create API key</Dialog.Title>
          <Dialog.Description>Give this key a name that describes where it will be used.</Dialog.Description>
        </Dialog.Header>

        <div class="mt-6">
          <label for="key-name" class="text-sm font-medium">Key name</label>
          <Input id="key-name" name="name" class="mt-2" maxlength={100} placeholder="e.g. My Slackbot (prod)" bind:value={keyName} autofocus />
          {#if errorMessage}<p class="text-destructive mt-2 text-sm">{errorMessage}</p>{/if}
        </div>

        <Dialog.Footer class="mt-6">
          <Button type="button" variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !keyName.trim()}>{busy ? "Creating…" : "Create key"}</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.done-attention) {
    animation: done-attention 500ms ease-out;
  }

  @keyframes done-attention {
    0%, 100% {
      filter: brightness(1);
      transform: scale(1);
      box-shadow: 0 0 0 0 transparent;
    }
    45% {
      filter: brightness(1.25);
      transform: scale(1.04);
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--primary) 30%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.done-attention) {
      animation: none;
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 30%, transparent);
    }
  }
</style>
