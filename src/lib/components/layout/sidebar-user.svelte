<script lang="ts">
  import AccountIcon from "remixicon-svelte/icons/user-settings-line";
  import ChevronsUpDownIcon from "remixicon-svelte/icons/expand-up-down-line";
  import LogOutIcon from "remixicon-svelte/icons/logout-box-r-line";
  import * as Avatar from "#lib/components/ui/avatar/index.ts";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.ts";
  import * as Sidebar from "#lib/components/ui/sidebar/index.ts";
  import { useSidebar } from "#lib/components/ui/sidebar/index.ts";

  let { user }: { user: { name: string | null; email: string | null; avatar: string | null } } = $props();

  const sidebar = useSidebar();
</script>

{#snippet identity()}
  <Avatar.Root class="size-8 rounded-lg">
    {#if user.avatar}<Avatar.Image src={user.avatar} alt={user.name} />{/if}
    <Avatar.Fallback class="rounded-lg" />
  </Avatar.Root>
  <div class="grid flex-1 text-start text-sm leading-tight">
    <span class="truncate font-medium">{user.name}</span>
    {#if user.email}<span class="text-muted-foreground truncate text-xs">{user.email}</span>{/if}
  </div>
{/snippet}

<Sidebar.Menu>
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="lg"
            class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            {@render identity()}
            <ChevronsUpDownIcon class="ms-auto size-4" />
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-(--bits-dropdown-menu-anchor-width) min-w-56 rounded-lg"
        side={sidebar.isMobile ? "bottom" : "right"}
        align="end"
        sideOffset={4}
      >
        <form method="POST" action="/auth/logout" class="[&>button]:w-full">
          <DropdownMenu.Item>
            {#snippet child({ props })}
              <button {...props} type="submit">
                <LogOutIcon />
                Log out
              </button>
            {/snippet}
          </DropdownMenu.Item>
        </form>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>
