<script lang="ts">
  import AddIcon from "remixicon-svelte/icons/add-line";
  import DeleteIcon from "remixicon-svelte/icons/delete-bin-line";
  import { invalidateAll } from "$app/navigation";
  import { CreateKeyDialog, RevokeKeyDialog, type ApiKey } from "#lib/components/keys/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import PageHeader from "#lib/components/page-header.svelte";
  import { formatDate, formatRelativeTime } from "#lib/format.ts";

  let { data } = $props();

  let createKeyDialog: { show: () => void } | undefined = $state();
  let revokeKeyDialog: { show: (key: ApiKey) => void } | undefined = $state();

  const lastUsed = (iso: string | null) => (iso ? formatRelativeTime(iso) : "Never");
</script>

<svelte:head><title>API keys</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="API keys" description="Make an API key to start using Hack Club AI in your apps!">
    {#snippet actions()}
      {#if data.keys.length > 0}
        <Button onclick={() => createKeyDialog?.show()}>
          <AddIcon data-icon="inline-start" class="size-4 shrink-0" />
          Create key
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  <CreateKeyDialog bind:this={createKeyDialog} exampleTemplate={data.exampleTemplate} oncreate={invalidateAll} />
  <RevokeKeyDialog bind:this={revokeKeyDialog} onrevoke={invalidateAll} />

  <section class="mt-10" aria-labelledby="keys-heading">
    <h2 id="keys-heading" class="sr-only">Your keys</h2>
    {#if data.keys.length > 0}
      <div class="text-muted-foreground hidden grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_2rem] gap-4 border-b py-3 text-sm sm:grid">
        <div>Key</div>
        <div>Created</div>
        <div>Last used</div>
        <div><span class="sr-only">Actions</span></div>
      </div>

      <ul role="list">
        {#each data.keys as key (key.id)}
          <li class="border-border flex min-w-0 items-start gap-4 border-b py-4 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_2rem] sm:items-center">
            <div class="min-w-0 flex-1">
              <p class="truncate text-base font-medium sm:text-sm">{key.name}</p>
              <p class="text-muted-foreground mt-1 truncate font-mono text-sm">{key.keyPreview}</p>
              <p class="text-muted-foreground mt-2 text-sm sm:hidden">Created {formatDate(key.createdAt)} · Last used {lastUsed(key.lastUsedAt)}</p>
            </div>
            <p class="text-muted-foreground hidden text-sm sm:block">{formatDate(key.createdAt)}</p>
            <p class="text-muted-foreground hidden text-sm sm:block">{lastUsed(key.lastUsedAt)}</p>
            <Button variant="destructive" size="icon-sm" class="relative" aria-label={`Revoke ${key.name}`} onclick={() => revokeKeyDialog?.show(key)}>
              <DeleteIcon class="size-4 shrink-0" />
              <span class="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true"></span>
            </Button>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="py-12 text-center">
        <h3 class="font-medium">No active keys</h3>
        <p class="text-muted-foreground mt-1 text-pretty text-base sm:text-sm">It's time to build something new, chief!</p>
        <Button class="mt-6 justify-center" size="lg" onclick={() => createKeyDialog?.show()}>
          <AddIcon data-icon="inline-start" class="size-5 shrink-0" />
          Create your first key
        </Button>
      </div>
    {/if}
  </section>
</div>
