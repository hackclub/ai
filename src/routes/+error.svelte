<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "#lib/components/ui/button/index.ts";

  const title = $derived(
    page.status === 404 ? "Page not found" : page.status === 403 ? "Forbidden" : "Something went wrong",
  );
</script>

<svelte:head><title>{page.status} · Hack Club AI</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col items-center px-4 py-24 text-center sm:px-6 lg:px-8">
  <p class="text-muted-foreground text-sm font-medium tabular-nums">{page.status}</p>
  <h1 class="mt-2 text-balance text-2xl font-semibold tracking-tight">{title}</h1>
  <p class="text-muted-foreground mt-2 max-w-[50ch] text-pretty text-base sm:text-sm">{page.error?.message ?? "Unexpected error."}</p>
  <Button href="/dashboard" variant="outline" class="mt-8">Back to dashboard</Button>
</div>
