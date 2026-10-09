<script lang="ts">
  import AddIcon from "remixicon-svelte/icons/add-line";
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { adminRequest } from "#lib/admin.ts";
  import { formatFullTime, formatUsd } from "#lib/format.ts";
  import type { GlobalPolicy } from "../../../dashboard/admin";

  let { data } = $props();

  const now = Date.now();
  const ended = (policy: GlobalPolicy) => policy.effectiveUntil !== null && new Date(policy.effectiveUntil).getTime() <= now;
  const allowances = $derived(data.policies.filter((policy) => policy.kind === "funding"));
  const limits = $derived(data.policies.filter((policy) => policy.kind === "limit"));

  type Form = {
    id: string | null;
    kind: "funding" | "limit";
    name: string;
    cadence: string;
    amountUsd: string;
    priority: number;
    enabled: boolean;
    effectiveUntil: string;
  };

  let open = $state(false);
  let form = $state<Form>(blank("funding"));
  let busy = $state(false);
  let errorMessage = $state("");
  let pageError = $state("");

  function blank(kind: "funding" | "limit"): Form {
    return { id: null, kind, name: "", cadence: "day", amountUsd: "", priority: 100, enabled: true, effectiveUntil: "" };
  }

  /** `datetime-local` wants local time without a zone. */
  const toLocalInput = (date: Date | string | null) => {
    if (!date) return "";
    const d = new Date(date);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  function create(kind: "funding" | "limit") {
    form = blank(kind);
    errorMessage = "";
    open = true;
  }

  function edit(policy: GlobalPolicy) {
    form = {
      id: policy.id,
      kind: policy.kind,
      name: policy.name,
      cadence: policy.cadence,
      amountUsd: Number(policy.amountUsd).toString(),
      priority: policy.priority ?? 100,
      enabled: policy.enabled,
      effectiveUntil: toLocalInput(policy.effectiveUntil),
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
      name: form.name,
      amountUsd: form.amountUsd.trim(),
      enabled: form.enabled,
      effectiveUntil: form.effectiveUntil ? new Date(form.effectiveUntil).toISOString() : null,
      ...(form.kind === "funding" ? { priority: form.priority } : {}),
    };
    try {
      const failure = form.id
        ? await adminRequest("PATCH", `/policies/${form.kind}/${form.id}`, body)
        : await adminRequest("POST", `/policies/${form.kind}`, { ...body, cadence: form.cadence });
      if (failure) errorMessage = failure;
      else open = false;
    } finally {
      busy = false;
    }
  }

  async function toggle(policy: GlobalPolicy) {
    pageError = (await adminRequest("PATCH", `/policies/${policy.kind}/${policy.id}`, { enabled: !policy.enabled })) ?? "";
  }

  /** Turning off or deleting a policy changes every user's spending at once, so it asks first. */
  let confirming = $state<{ policy: GlobalPolicy; action: "off" | "delete" } | null>(null);
  let confirmOpen = $state(false);

  function ask(policy: GlobalPolicy, action: "off" | "delete") {
    confirming = { policy, action };
    confirmOpen = true;
  }

  async function confirm() {
    if (!confirming || busy) return;
    const { policy, action } = confirming;
    busy = true;
    try {
      pageError =
        (action === "off"
          ? await adminRequest("PATCH", `/policies/${policy.kind}/${policy.id}`, { enabled: false })
          : await adminRequest("DELETE", `/policies/${policy.kind}/${policy.id}`)) ?? "";
      confirmOpen = false;
    } finally {
      busy = false;
    }
  }

  const cell = "px-4 py-3 text-sm";
  const select =
    "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent py-1 ps-2.5 pe-8 text-base shadow-xs outline-none focus-visible:ring-3 disabled:opacity-60 md:text-sm";
</script>

<svelte:head><title>Policies · Admin</title></svelte:head>

{#snippet table(policies: GlobalPolicy[], kind: "funding" | "limit")}
  {#if policies.length === 0}
    <EmptyState
      title={kind === "funding" ? "No global allowance" : "No global limits"}
      description={kind === "funding" ? "Users without an allowance of their own cannot make any request." : "Users can spend their whole allowance."}
    />
  {:else}
    <div class="overflow-x-auto rounded-lg border">
      <table class="w-full border-collapse text-left">
        <thead class="text-muted-foreground border-b text-xs">
          <tr>
            <th class="{cell} font-medium">Name</th>
            <th class="{cell} font-medium">{kind === "funding" ? "Allowance" : "Cap"}</th>
            {#if kind === "funding"}<th class="{cell} font-medium">Priority</th>{/if}
            <th class="{cell} font-medium">Status</th>
            <th class="{cell} font-medium"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each policies as policy (policy.id)}
            <tr class="border-b last:border-b-0 {policy.enabled && !ended(policy) ? '' : 'text-muted-foreground'}">
              <td class="{cell} font-medium">{policy.name}</td>
              <td class="{cell} tabular-nums whitespace-nowrap">
                {formatUsd(policy.amountUsd)} {policy.cadence === "lifetime" ? "in total" : `per ${policy.cadence}`}
                {#if policy.timezone !== "UTC"}<span class="text-muted-foreground text-xs">({policy.timezone})</span>{/if}
              </td>
              {#if kind === "funding"}<td class="{cell} tabular-nums">{policy.priority}</td>{/if}
              <td class="{cell} whitespace-nowrap">
                {#if ended(policy)}
                  Ended
                {:else if policy.enabled}
                  <span class="text-primary font-medium">On</span>
                  {#if policy.effectiveUntil}<span class="text-muted-foreground text-xs">until {formatFullTime(policy.effectiveUntil)}</span>{/if}
                {:else}
                  Off
                {/if}
              </td>
              <td class="{cell} whitespace-nowrap text-end">
                {#if !ended(policy)}
                  {#if policy.enabled}
                    <Button variant="ghost" size="sm" onclick={() => ask(policy, "off")}>Turn off</Button>
                  {:else}
                    <Button variant="ghost" size="sm" onclick={() => toggle(policy)}>Turn on</Button>
                  {/if}
                  <Button variant="ghost" size="sm" onclick={() => edit(policy)}>Edit</Button>
                  <Button variant="ghost" size="sm" class="text-destructive" onclick={() => ask(policy, "delete")}>Delete</Button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if kind === "funding" && policies[0] && policies[0].overriddenAccounts > 0}
      <p class="text-muted-foreground mt-2 text-xs">
        {policies[0].overriddenAccounts.toLocaleString()}
        {policies[0].overriddenAccounts === 1 ? "account has" : "accounts have"}
        an allowance of their own, which replaces these.
      </p>
    {/if}
  {/if}
{/snippet}

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader
    title="Policies"
    description="Global allowances fund every user; global limits cap what they spend. A change to an amount applies to the current period straight away."
  />

  {#if pageError}<p class="text-destructive mt-6 text-sm">{pageError}</p>{/if}

  <section class="mt-8" aria-labelledby="allowances-heading">
    <div class="mb-3 flex items-center justify-between">
      <h2 id="allowances-heading" class="text-sm font-medium">Allowances</h2>
      <Button variant="outline" size="sm" onclick={() => create("funding")}><AddIcon data-icon="inline-start" /> New allowance</Button>
    </div>
    {@render table(allowances, "funding")}
  </section>

  <section class="mt-10" aria-labelledby="limits-heading">
    <div class="mb-3 flex items-center justify-between">
      <h2 id="limits-heading" class="text-sm font-medium">Limits</h2>
      <Button variant="outline" size="sm" onclick={() => create("limit")}><AddIcon data-icon="inline-start" /> New limit</Button>
    </div>
    {@render table(limits, "limit")}
    <p class="text-muted-foreground mt-2 text-xs">
      A limit refuses requests once a user's spend in the period reaches it, whatever allowance they have left. Deleting a policy that was ever used ends it instead, so past periods keep their record.
    </p>
  </section>
</div>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <form onsubmit={save}>
      <Dialog.Header>
        <Dialog.Title>
          {form.id ? "Edit" : "New"} {form.kind === "funding" ? "allowance" : "limit"}
        </Dialog.Title>
        <Dialog.Description>
          {form.kind === "funding"
            ? "Applies to every user without an allowance of their own."
            : "Applies to every user, on top of any limit of their own."}
        </Dialog.Description>
      </Dialog.Header>

      <div class="mt-6 grid gap-4">
        <div>
          <label for="policy-name" class="text-sm font-medium">Name</label>
          <Input id="policy-name" class="mt-2" maxlength={100} required bind:value={form.name} placeholder={form.kind === "funding" ? "Daily allowance" : "OpenRouter top-up wait"} />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="policy-amount" class="text-sm font-medium">{form.kind === "funding" ? "Amount" : "Cap"} (USD)</label>
            <Input id="policy-amount" class="mt-2" inputmode="decimal" required pattern={"\\d+(\\.\\d{1,12})?"} bind:value={form.amountUsd} placeholder={form.kind === "funding" ? "3" : "0.60"} />
          </div>
          <div>
            <label for="policy-cadence" class="text-sm font-medium">Per</label>
            <select id="policy-cadence" class="{select} mt-2" bind:value={form.cadence} disabled={form.id !== null} title={form.id ? "Create a new policy to change the period" : undefined}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
              {#if form.kind === "limit"}<option value="lifetime">Lifetime</option>{/if}
            </select>
          </div>
        </div>
        {#if form.kind === "funding"}
          <div>
            <label for="policy-priority" class="text-sm font-medium">Priority</label>
            <Input id="policy-priority" class="mt-2" type="number" step="1" required bind:value={form.priority} />
            <p class="text-muted-foreground mt-1 text-xs">Lower is spent first when several allowances apply.</p>
          </div>
        {/if}
        <div>
          <label for="policy-until" class="text-sm font-medium">Ends <span class="text-muted-foreground font-normal">(optional, your local time)</span></label>
          <Input id="policy-until" class="mt-2" type="datetime-local" bind:value={form.effectiveUntil} />
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

<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content class="sm:max-w-md">
    {#if confirming}
      <Dialog.Header>
        <Dialog.Title>{confirming.action === "off" ? "Turn off" : "Delete"} {confirming.policy.name}?</Dialog.Title>
        <Dialog.Description>
          {#if confirming.policy.kind === "funding"}
            Every user funded by it loses this allowance straight away. Requests it was paying for will be refused.
          {:else}
            Every user stops being capped by it straight away.
          {/if}
          {#if confirming.action === "delete"}It cannot be turned back on.{/if}
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer class="mt-6">
        <Button type="button" variant="outline" size="sm" onclick={() => (confirmOpen = false)}>Cancel</Button>
        <Button size="sm" variant="destructive" disabled={busy} onclick={confirm}>
          {confirming.action === "off" ? "Turn off" : "Delete"}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
