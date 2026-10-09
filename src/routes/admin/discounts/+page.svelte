<script lang="ts">
  import AddIcon from "remixicon-svelte/icons/add-line";
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { adminRequest } from "#lib/admin.ts";
  import { formatFullTime, formatUsd } from "#lib/format.ts";
  import type { Discount } from "../../../dashboard/admin";

  let { data } = $props();

  const now = Date.now();
  const status = (discount: Discount) => {
    if (discount.endsAt && new Date(discount.endsAt).getTime() <= now) return "Ended";
    return discount.enabled ? "On" : "Off";
  };
  const percent = (value: string) => `${Number(value)}%`;

  type Form = {
    id: string | null;
    modelPattern: string;
    servedBy: string;
    percentOff: string;
    note: string;
    enabled: boolean;
    endsAt: string;
  };

  const blank = (): Form => ({ id: null, modelPattern: "", servedBy: "", percentOff: "", note: "", enabled: true, endsAt: "" });

  let open = $state(false);
  let form = $state<Form>(blank());
  let busy = $state(false);
  let errorMessage = $state("");
  let pageError = $state("");
  let deleting = $state<Discount | null>(null);
  let deleteOpen = $state(false);

  const toLocalInput = (date: Date | string | null) => {
    if (!date) return "";
    const d = new Date(date);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  /** Upstreams offered: those seen recently, plus the one an existing discount already names. */
  const upstreams = $derived(
    form.servedBy && !data.servedBy.some((upstream) => upstream.servedBy === form.servedBy)
      ? [...data.servedBy, { servedBy: form.servedBy, requests: 0, costUsd: "0" }]
      : data.servedBy,
  );

  function create() {
    form = blank();
    errorMessage = "";
    open = true;
  }

  function edit(discount: Discount) {
    form = {
      id: discount.id,
      modelPattern: discount.modelPattern ?? "",
      servedBy: discount.servedBy ?? "",
      percentOff: Number(discount.percentOff).toString(),
      note: discount.note ?? "",
      enabled: discount.enabled,
      endsAt: toLocalInput(discount.endsAt),
    };
    errorMessage = "";
    open = true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    errorMessage = "";
    const body = {
      modelPattern: form.modelPattern.trim() || null,
      servedBy: form.servedBy || null,
      percentOff: form.percentOff.trim(),
      note: form.note.trim() || null,
      enabled: form.enabled,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
    };
    try {
      const failure = form.id ? await adminRequest("PUT", `/discounts/${form.id}`, body) : await adminRequest("POST", "/discounts", body);
      if (failure) errorMessage = failure;
      else open = false;
    } finally {
      busy = false;
    }
  }

  async function confirmDelete() {
    if (!deleting || busy) return;
    busy = true;
    try {
      pageError = (await adminRequest("DELETE", `/discounts/${deleting.id}`)) ?? "";
      deleteOpen = false;
    } finally {
      busy = false;
    }
  }

  const cell = "px-4 py-3 text-sm";
  const select =
    "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent py-1 ps-2.5 pe-8 text-base shadow-xs outline-none focus-visible:ring-3 md:text-sm";
</script>

<svelte:head><title>Discounts · Admin</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Discounts" description="Lower what users are charged for a model, for an upstream provider, or both. The models pages show discounts to users.">
    {#snippet actions()}
      <Button size="sm" onclick={create}><AddIcon data-icon="inline-start" /> New discount</Button>
    {/snippet}
  </PageHeader>

  <div class="bg-muted/50 mt-6 rounded-lg border px-4 py-3 text-sm">
    <p class="font-medium">An upstream discount only applies when that upstream serves the request.</p>
    <p class="text-muted-foreground mt-1">
      A discount on Anthropic does nothing for a request OpenRouter routes to Amazon Bedrock or Google, even for a Claude model. Such requests are charged in full.
      Reservations are always held at full price; the discount is taken off when the request is billed.
    </p>
  </div>

  {#if pageError}<p class="text-destructive mt-4 text-sm">{pageError}</p>{/if}

  <section class="mt-8">
    {#if data.discounts.length === 0}
      <EmptyState title="No discounts" description="Every request is charged what the provider charged us." />
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <thead class="text-muted-foreground border-b text-xs">
            <tr>
              <th class="{cell} font-medium">Applies to</th>
              <th class="{cell} font-medium">Off</th>
              <th class="{cell} font-medium">Status</th>
              <th class="{cell} font-medium"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data.discounts as discount (discount.id)}
              <tr class="border-b last:border-b-0 {status(discount) === 'On' ? '' : 'text-muted-foreground'}">
                <td class="{cell}">
                  <p class="font-medium">
                    {#if discount.modelPattern}
                      <span class="font-mono text-xs">{discount.modelPattern}</span>
                    {:else}
                      Every model
                    {/if}
                  </p>
                  {#if discount.servedBy}
                    <p class="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Only when served by {discount.servedBy}</p>
                  {/if}
                  {#if discount.note}<p class="text-muted-foreground mt-0.5 text-xs">{discount.note}</p>{/if}
                </td>
                <td class="{cell} text-base font-semibold tabular-nums">{percent(discount.percentOff)}</td>
                <td class="{cell} whitespace-nowrap">
                  {#if status(discount) === "On"}
                    <span class="text-primary font-medium">On</span>
                  {:else}
                    {status(discount)}
                  {/if}
                  {#if discount.endsAt && status(discount) !== "Ended"}
                    <span class="text-muted-foreground block text-xs">until {formatFullTime(discount.endsAt)}</span>
                  {/if}
                </td>
                <td class="{cell} whitespace-nowrap text-end">
                  <Button variant="ghost" size="sm" onclick={() => edit(discount)}>Edit</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive"
                    onclick={() => {
                      deleting = discount;
                      deleteOpen = true;
                    }}>Delete</Button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<datalist id="discount-models">
  {#each data.models as model (model)}<option value={model}></option>{/each}
</datalist>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={save}>
      <Dialog.Header>
        <Dialog.Title>{form.id ? "Edit discount" : "New discount"}</Dialog.Title>
        <Dialog.Description>Set a model, an upstream provider, or both. If several discounts match a request, the largest applies.</Dialog.Description>
      </Dialog.Header>

      <div class="mt-6 grid gap-4">
        <div>
          <label for="discount-model" class="text-sm font-medium">Model <span class="text-muted-foreground font-normal">(optional)</span></label>
          <Input id="discount-model" class="mt-2 font-mono" list="discount-models" maxlength={200} bind:value={form.modelPattern} placeholder="anthropic/* or anthropic/claude-sonnet-5" />
          <p class="text-muted-foreground mt-1 text-xs">A model ID, or a prefix ending in <code>*</code> for every matching model. Empty for every model.</p>
        </div>

        <div>
          <label for="discount-upstream" class="text-sm font-medium">Upstream provider <span class="text-muted-foreground font-normal">(optional)</span></label>
          <select id="discount-upstream" class="{select} mt-2" bind:value={form.servedBy}>
            <option value="">Any upstream</option>
            {#each upstreams as upstream (upstream.servedBy)}
              <option value={upstream.servedBy}>
                {upstream.servedBy}{upstream.requests > 0 ? ` (${upstream.requests.toLocaleString()} requests, ${formatUsd(upstream.costUsd)} in 30 days)` : " (no requests in 30 days)"}
              </option>
            {/each}
          </select>
          {#if form.servedBy}
            <p class="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
              Applies only to requests {form.servedBy} actually serves. Requests routed to any other upstream are charged in full.
            </p>
          {:else if data.servedBy.length === 0}
            <p class="text-muted-foreground mt-1 text-xs">No upstream has been recorded in the last 30 days yet.</p>
          {:else}
            <p class="text-muted-foreground mt-1 text-xs">Only upstreams that have served requests in the last 30 days are listed.</p>
          {/if}
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="discount-percent" class="text-sm font-medium">Percent off</label>
            <Input id="discount-percent" class="mt-2" inputmode="decimal" required pattern={"\\d{1,3}(\\.\\d{1,2})?"} bind:value={form.percentOff} placeholder="100" />
          </div>
          <div>
            <label for="discount-ends" class="text-sm font-medium">Ends <span class="text-muted-foreground font-normal">(optional)</span></label>
            <Input id="discount-ends" class="mt-2" type="datetime-local" bind:value={form.endsAt} />
          </div>
        </div>

        <div>
          <label for="discount-note" class="text-sm font-medium">Note <span class="text-muted-foreground font-normal">(shown to users)</span></label>
          <Input id="discount-note" class="mt-2" maxlength={500} bind:value={form.note} placeholder="Covered by our Anthropic credits" />
        </div>

        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="accent-primary size-4" bind:checked={form.enabled} />
          On
        </label>
        {#if errorMessage}<p class="text-destructive text-sm">{errorMessage}</p>{/if}
      </div>

      <Dialog.Footer class="mt-6">
        <Button type="button" variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : form.id ? "Save" : "Create"}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="sm:max-w-md">
    {#if deleting}
      <Dialog.Header>
        <Dialog.Title>Delete this discount?</Dialog.Title>
        <Dialog.Description>
          Requests billed from now on are charged in full. Requests already billed keep their discount.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer class="mt-6">
        <Button type="button" variant="outline" size="sm" onclick={() => (deleteOpen = false)}>Cancel</Button>
        <Button size="sm" variant="destructive" disabled={busy} onclick={confirmDelete}>Delete</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
