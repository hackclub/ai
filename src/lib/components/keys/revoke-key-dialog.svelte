<script lang="ts">
  import DeleteIcon from "remixicon-svelte/icons/delete-bin-line";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import type { ApiKey } from "./types.js";

  let { onrevoke }: { onrevoke: () => void | Promise<void> } = $props();
  let open = $state(false);
  let key = $state<ApiKey | null>(null);
  let busy = $state(false);
  let errorMessage = $state("");

  export function show(selectedKey: ApiKey) {
    key = selectedKey;
    errorMessage = "";
    open = true;
  }

  async function revokeKey() {
    if (!key || busy) return;
    busy = true;
    errorMessage = "";
    try {
      const response = await fetch(`/api/keys/${key.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        errorMessage = body.error ?? "Could not revoke the key.";
        return;
      }
      await onrevoke();
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Revoke API key?</Dialog.Title>
      <Dialog.Description>
        <span class="font-semibold">"{key?.name}"</span> will stop working immediately. <b>You can't undo this action!</b>
      </Dialog.Description>
    </Dialog.Header>

    {#if errorMessage}<p class="text-destructive text-sm">{errorMessage}</p>{/if}

    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
      <Button variant="destructive" size="sm" onclick={revokeKey} disabled={busy}>
        <DeleteIcon data-icon="inline-start" class="size-4 shrink-0" />
        {busy ? "Revoking…" : "Revoke key"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
