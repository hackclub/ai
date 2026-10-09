<script lang="ts">
  import ArrowLeftIcon from "remixicon-svelte/icons/arrow-left-line";
  import EmptyState from "#lib/components/empty-state.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { adminRequest } from "#lib/admin.ts";
  import { displayModelName, formatFullTime, formatRelativeTime, formatUsd } from "#lib/format.ts";

  let { data } = $props();
  const user = $derived(data.user);

  let banOpen = $state(false);
  let reason = $state("");
  let busy = $state(false);
  let errorMessage = $state("");

  const openBan = () => {
    reason = "";
    errorMessage = "";
    banOpen = true;
  };

  async function setBanned(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    errorMessage = "";
    try {
      const failure = await adminRequest("POST", `/users/${user.id}/ban`, { banned: !user.isBanned, reason: reason.trim() || null });
      if (failure) errorMessage = failure;
      else banOpen = false;
    } finally {
      busy = false;
    }
  }

  const spendCards = $derived([
    { label: "Today", value: formatUsd(data.spend.todayUsd) },
    { label: "Last 7 days", value: formatUsd(data.spend.weekUsd) },
    { label: "Last 30 days", value: formatUsd(data.spend.monthUsd) },
    { label: "Lifetime", value: formatUsd(data.spend.lifetimeUsd) },
  ]);

  const cell = "px-4 py-2.5 text-sm";
  const ACTIONS: Record<string, string> = { user_banned: "Banned", user_unbanned: "Unbanned" };
</script>

<svelte:head><title>{user.name ?? "User"} · Admin</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <a href="/admin/users" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
    <ArrowLeftIcon class="size-4" /> Users
  </a>

  <div class="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div class="flex min-w-0 items-center gap-3">
      {#if user.avatar}<img src={user.avatar} alt="" class="size-12 shrink-0 rounded-full" />{/if}
      <div class="min-w-0">
        <h1 class="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          <span class="truncate">{user.name ?? "Unnamed"}</span>
          {#if user.isBanned}
            <span class="bg-destructive/10 text-destructive rounded px-2 py-0.5 text-xs font-medium">Banned</span>
          {:else}
            <span class="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs font-medium">Active</span>
          {/if}
          {#if user.isAdmin}<span class="bg-muted text-muted-foreground rounded px-2 py-0.5 text-xs font-medium">Admin</span>{/if}
        </h1>
        <p class="text-muted-foreground mt-0.5 truncate text-sm">
          {user.email ?? "No email"} · <span class="font-mono text-xs">{user.slackId}</span>
        </p>
      </div>
    </div>
    {#if !data.isSelf || user.isBanned}
      <Button variant={user.isBanned ? "outline" : "destructive"} size="sm" onclick={openBan}>
        {user.isBanned ? "Unban" : "Ban"}
      </Button>
    {/if}
  </div>

  <dl class="text-muted-foreground mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
    <div><dt class="inline">Joined</dt> <dd class="text-foreground inline">{formatFullTime(user.createdAt)}</dd></div>
    <div><dt class="inline">IDV</dt> <dd class="text-foreground inline">{user.isIdvVerified ? "Verified" : "Not verified"}</dd></div>
    <div><dt class="inline">Active keys</dt> <dd class="text-foreground inline tabular-nums">{user.activeKeys}</dd></div>
    <div>
      <dt class="inline">Last request</dt>
      <dd class="text-foreground inline">
        {#if data.spend.lastRequestAt}
          <abbr class="no-underline" title={formatFullTime(`${data.spend.lastRequestAt}Z`)}>{formatRelativeTime(`${data.spend.lastRequestAt}Z`)}</abbr>
        {:else}Never{/if}
      </dd>
    </div>
  </dl>

  <section class="mt-8" aria-labelledby="spend-heading">
    <h2 id="spend-heading" class="mb-3 text-sm font-medium">Spend</h2>
    <dl class="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border lg:grid-cols-4">
      {#each spendCards as card (card.label)}
        <div class="bg-card flex flex-col gap-1 px-4 py-4 sm:px-5">
          <dt class="text-muted-foreground text-xs font-medium">{card.label}</dt>
          <dd class="text-2xl font-semibold tracking-tight tabular-nums">{card.value}</dd>
        </div>
      {/each}
    </dl>
    <p class="text-muted-foreground mt-2 text-xs tabular-nums">{data.spend.monthRequests.toLocaleString()} {data.spend.monthRequests === 1 ? "request" : "requests"} in the last 30 days.</p>
  </section>

  <section class="mt-8" aria-labelledby="policies-heading">
    <h2 id="policies-heading" class="mb-3 text-sm font-medium">Allowances and limits</h2>
    {#if user.policies.length === 0}
      <EmptyState title="No allowance" description="No funding policy applies to this user, so every request is refused." />
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <thead class="text-muted-foreground border-b text-xs">
            <tr>
              <th class="{cell} font-medium">Policy</th>
              <th class="{cell} font-medium">Type</th>
              <th class="{cell} font-medium">This period</th>
            </tr>
          </thead>
          <tbody>
            {#each user.policies as policy (policy.id)}
              <tr class="border-b last:border-b-0 {policy.enabled ? '' : 'text-muted-foreground'}">
                <td class="{cell} font-medium">
                  {policy.name}
                  <span class="text-muted-foreground bg-muted ms-1 rounded px-1.5 py-0.5 text-xs font-normal">{policy.global ? "Global" : "This user only"}</span>
                  {#if !policy.enabled}<span class="text-muted-foreground ms-1 text-xs font-normal">Disabled</span>{/if}
                </td>
                <td class="{cell} text-muted-foreground">{policy.kind === "funding" ? "Allowance" : "Limit"} per {policy.cadence}</td>
                <td class="{cell} tabular-nums whitespace-nowrap">
                  {formatUsd(policy.usedUsd ?? "0")} of {formatUsd(policy.windowAmountUsd ?? policy.amountUsd)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if data.spend.topModels.length > 0}
    <section class="mt-8" aria-labelledby="models-heading">
      <h2 id="models-heading" class="mb-3 text-sm font-medium">Top models, last 30 days</h2>
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <tbody>
            {#each data.spend.topModels as model (model.model)}
              <tr class="border-b last:border-b-0">
                <td class="{cell} max-w-80 truncate font-medium">{displayModelName(model.model)}</td>
                <td class="{cell} text-muted-foreground text-end tabular-nums">{model.requests.toLocaleString()} {model.requests === 1 ? "request" : "requests"}</td>
                <td class="{cell} text-end tabular-nums">{formatUsd(model.spendUsd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  <section class="mt-8" aria-labelledby="recent-heading">
    <h2 id="recent-heading" class="mb-3 text-sm font-medium">Recent requests</h2>
    {#if data.recent.length === 0}
      <EmptyState title="No requests yet" />
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <thead class="text-muted-foreground border-b text-xs">
            <tr>
              <th class="{cell} font-medium">Time</th>
              <th class="{cell} font-medium">Model</th>
              <th class="{cell} font-medium">Tokens</th>
              <th class="{cell} font-medium">Cost</th>
              <th class="{cell} font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {#each data.recent as request (request.requestId)}
              <tr class="border-b last:border-b-0">
                <td class="{cell} whitespace-nowrap">
                  <abbr class="no-underline" title={`${formatFullTime(request.occurredAt)}\nIP: ${request.ip || "unknown"}`}>{formatRelativeTime(request.occurredAt)}</abbr>
                </td>
                <td class="{cell} max-w-64 truncate font-medium">{displayModelName(request.model)}</td>
                <td class="{cell} text-muted-foreground whitespace-nowrap tabular-nums">
                  {request.inputTokens.toLocaleString()} in / {request.outputTokens.toLocaleString()} out
                </td>
                <td class="{cell} text-muted-foreground whitespace-nowrap tabular-nums">{formatUsd(request.billedCostUsd)}</td>
                <td class="{cell} whitespace-nowrap">
                  {#if request.outcome === "completed" || request.outcome === "reconciled"}
                    <span class="text-primary font-medium">OK</span>
                  {:else}
                    <abbr class="text-destructive font-medium no-underline" title={request.errorCode || request.outcome}>Error</abbr>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="mt-8" aria-labelledby="abuse-heading">
    <h2 id="abuse-heading" class="mb-3 text-sm font-medium">Abuse rule matches</h2>
    {#if user.abuseEvents.length === 0}
      <p class="text-muted-foreground text-sm">No abuse rule has matched this user's requests.</p>
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <table class="w-full border-collapse text-left">
          <thead class="text-muted-foreground border-b text-xs">
            <tr>
              <th class="{cell} font-medium">Time</th>
              <th class="{cell} font-medium">Rule</th>
              <th class="{cell} font-medium">Endpoint</th>
              <th class="{cell} font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each user.abuseEvents as event, index (index)}
              <tr class="border-b last:border-b-0">
                <td class="{cell} whitespace-nowrap">
                  <abbr class="no-underline" title={formatFullTime(event.occurredAt)}>{formatRelativeTime(event.occurredAt)}</abbr>
                </td>
                <td class="{cell} max-w-80 truncate"><span class="text-muted-foreground">{event.kind}:</span> {event.rule}</td>
                <td class="{cell} text-muted-foreground">{event.endpoint}</td>
                <td class="{cell} whitespace-nowrap {event.enforced ? 'text-destructive font-medium' : 'text-muted-foreground'}">
                  {event.enforced ? "Blocked" : "Shadow"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if user.history.length > 0}
    <section class="mt-8" aria-labelledby="history-heading">
      <h2 id="history-heading" class="mb-3 text-sm font-medium">Admin history</h2>
      <ul class="space-y-2 text-sm">
        {#each user.history as entry, index (index)}
          <li>
            <span class="font-medium">{ACTIONS[entry.action] ?? entry.action}</span>
            by {entry.actor ?? "an admin"}
            <abbr class="text-muted-foreground no-underline" title={formatFullTime(entry.createdAt)}>{formatRelativeTime(entry.createdAt)}</abbr>
            {#if entry.reason}<p class="text-muted-foreground">{entry.reason}</p>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<Dialog.Root bind:open={banOpen}>
  <Dialog.Content class="sm:max-w-md">
    <form onsubmit={setBanned}>
      <Dialog.Header>
        <Dialog.Title>{user.isBanned ? "Unban" : "Ban"} {user.name ?? "this user"}?</Dialog.Title>
        <Dialog.Description>
          {#if user.isBanned}
            Their API keys and dashboard work again from their next request.
          {:else}
            Every API key and dashboard session they have stops working from their next request.
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <div class="mt-6">
        <label for="ban-reason" class="text-sm font-medium">Reason <span class="text-muted-foreground font-normal">(kept in the admin history)</span></label>
        <Input id="ban-reason" class="mt-2" maxlength={500} bind:value={reason} autofocus />
        {#if errorMessage}<p class="text-destructive mt-2 text-sm">{errorMessage}</p>{/if}
      </div>
      <Dialog.Footer class="mt-6">
        <Button type="button" variant="outline" size="sm" onclick={() => (banOpen = false)}>Cancel</Button>
        <Button type="submit" size="sm" variant={user.isBanned ? "default" : "destructive"} disabled={busy}>
          {busy ? "Saving…" : user.isBanned ? "Unban" : "Ban"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
