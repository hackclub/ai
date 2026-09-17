<script lang="ts">
  import PageHeader from "#lib/components/page-header.svelte";
  import ModelsList from "#lib/components/models-list.svelte";

  let { data } = $props();
</script>

<svelte:head><title>Models</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Models" description="Find the right model for your project. Click a model for pricing, limits and code examples." />
  <ModelsList title="Language models" models={data.languageModels} />
  <ModelsList title="Image models" models={data.imageModels} />
  <ModelsList title="Embedding models" models={data.embeddingModels} />
</div>
