<script lang="ts">
  import ImageIcon from "remixicon-svelte/icons/image-line";
  import ExternalIcon from "remixicon-svelte/icons/external-link-line";
  import PageHeader from "#lib/components/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";

  let { data } = $props();
</script>

<svelte:head><title>Replicate</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Replicate" description="Run AI models through Replicate's predictions API. Background removal, speech, upscaling and more.">
    {#snippet actions()}
      <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Beta</span>
      <Button href="https://docs.ai.hackclub.com/guide/replicate.html" target="_blank" rel="noopener" variant="outline" size="sm">
        Replicate docs
        <ExternalIcon data-icon="inline-end" class="size-4" />
      </Button>
    {/snippet}
  </PageHeader>

  {#each data.categories as category (category.name)}
    {#if category.models.length > 0}
      <section class="mt-10" aria-label={category.name}>
        <h2 class="mb-4 text-sm font-medium">{category.name}</h2>
        <ul role="list" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each category.models as model (`${model.owner}/${model.name}`)}
            {@const description = model.description ?? ""}
            <li>
              <a
                href="https://replicate.com/{model.owner}/{model.name}"
                target="_blank"
                rel="noopener noreferrer"
                class="group bg-card hover:bg-muted/60 focus-visible:ring-ring/50 flex h-full flex-col overflow-hidden rounded-lg border transition-colors outline-none focus-visible:ring-3"
              >
                <div class="bg-muted aspect-video">
                  {#if model.cover_image_url}
                    <img src={model.cover_image_url} alt="" loading="lazy" class="size-full object-cover" />
                  {:else}
                    <div class="text-muted-foreground flex size-full items-center justify-center">
                      <ImageIcon class="size-8" />
                    </div>
                  {/if}
                </div>
                <div class="flex flex-1 flex-col gap-1 p-4">
                  <p class="truncate text-sm">
                    <span class="text-muted-foreground">{model.owner}/</span><span class="font-medium">{model.name}</span>
                  </p>
                  {#if description}
                    <p class="text-muted-foreground line-clamp-2 text-sm text-pretty">{description}</p>
                  {/if}
                </div>
              </a>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/each}
</div>
