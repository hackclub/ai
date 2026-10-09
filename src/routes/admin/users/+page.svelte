<script lang="ts">
  import SearchIcon from "remixicon-svelte/icons/search-line";
  import { goto } from "$app/navigation";
  import { navigating } from "$app/state";
  import EmptyState from "#lib/components/empty-state.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { formatFullTime, formatRelativeTime } from "#lib/format.ts";

  let { data } = $props();

  let query = $derived(data.query);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onSearch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = query.trim();
      goto(q ? `?q=${encodeURIComponent(q)}` : "/admin/users", { reset: false, replace: true });
    }, 300);
  };

  const cell = "px-4 py-3 text-sm";
</script>

<svelte:head><title>Users · Admin</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
  <PageHeader title="Users" description="Look up a user to see their status and usage, or ban them." />

  <div class="relative mt-8 mb-4">
    <SearchIcon class="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
    <Input
      type="search"
      placeholder="Name, email, Slack ID, user ID or key prefix"
      aria-label="Search users"
      class="ps-8"
      bind:value={query}
      oninput={onSearch}
    />
  </div>

  {#if data.users.length === 0}
    <EmptyState title="No users found" description="Try their Slack ID, or the start of one of their API keys." />
  {:else}
    {#if !data.query}<p class="text-muted-foreground mb-2 text-xs">Newest users</p>{/if}
    <div class="overflow-x-auto rounded-lg border transition-opacity {navigating.to ? 'opacity-60' : ''}">
      <table class="w-full border-collapse text-left">
        <thead class="text-muted-foreground border-b text-xs">
          <tr>
            <th class="{cell} font-medium">User</th>
            <th class="{cell} font-medium">Slack ID</th>
            <th class="{cell} font-medium">Joined</th>
            <th class="{cell} font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each data.users as user (user.id)}
            <tr class="hover:bg-muted/40 border-b last:border-b-0">
              <td class="{cell} max-w-72">
                <a href="/admin/users/{user.id}" class="flex min-w-0 items-center gap-2 font-medium hover:underline">
                  {#if user.avatar}<img src={user.avatar} alt="" class="size-6 shrink-0 rounded-full" />{/if}
                  <span class="truncate">{user.name ?? "Unnamed"}</span>
                </a>
                {#if user.email}<p class="text-muted-foreground truncate text-xs">{user.email}</p>{/if}
              </td>
              <td class="{cell} text-muted-foreground font-mono text-xs">{user.slackId}</td>
              <td class="{cell} text-muted-foreground whitespace-nowrap">
                <abbr class="no-underline" title={formatFullTime(user.createdAt)}>{formatRelativeTime(user.createdAt)}</abbr>
              </td>
              <td class="{cell} whitespace-nowrap">
                {#if user.isBanned}
                  <span class="text-destructive font-medium">Banned</span>
                {:else}
                  <span class="text-primary font-medium">Active</span>
                {/if}
                {#if user.isAdmin}<span class="text-muted-foreground bg-muted ms-1 rounded px-1.5 py-0.5 text-xs">Admin</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
