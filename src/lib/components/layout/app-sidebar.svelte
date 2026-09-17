<script lang="ts">
  import DashboardIcon from "remixicon-svelte/icons/dashboard-line";
  import KeyIcon from "remixicon-svelte/icons/key-2-line";
  import CpuIcon from "remixicon-svelte/icons/cpu-line";
  import PulseIcon from "remixicon-svelte/icons/pulse-line";
  import GlobeIcon from "remixicon-svelte/icons/earth-line";
  import BookIcon from "remixicon-svelte/icons/book-open-line";
  import FlaskIcon from "remixicon-svelte/icons/flask-line";
  import { page } from "$app/state";
  import * as Sidebar from "#lib/components/ui/sidebar/index.ts";
  import SidebarUser from "#lib/components/layout/sidebar-user.svelte";

  type SidebarUserData = { name: string | null; email: string | null; avatar: string | null };
  let { user, replicateEnabled = false }: { user: SidebarUserData; replicateEnabled?: boolean } = $props();

  const items = $derived([
    { title: "Dashboard", url: "/dashboard", icon: DashboardIcon },
    { title: "API keys", url: "/keys", icon: KeyIcon },
    { title: "Models", url: "/models", icon: CpuIcon },
    { title: "Activity", url: "/activity", icon: PulseIcon },
    ...(replicateEnabled ? [{ title: "Replicate", url: "/replicate", icon: FlaskIcon }] : []),
    { title: "Global stats", url: "/global", icon: GlobeIcon },
  ]);

  const isActive = (url: string) => page.url.pathname === url || page.url.pathname.startsWith(`${url}/`);
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton size="lg">
          {#snippet child({ props })}
            <a href="/dashboard" {...props}>
              <div class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg text-base font-bold">
                h
              </div>
              <div class="grid flex-1 text-start text-sm leading-tight">
                <span class="truncate font-semibold">Hack Club AI</span>
                <span class="text-muted-foreground truncate text-xs">Free AI for Hack Clubbers</span>
              </div>
            </a>
          {/snippet}
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Header>

  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.GroupLabel>Application</Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each items as item (item.url)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={isActive(item.url)}>
                {#snippet child({ props })}
                  <a href={item.url} {...props}>
                    <item.icon />
                    <span>{item.title}</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>

    <Sidebar.Group>
      <Sidebar.GroupLabel>Resources</Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          <Sidebar.MenuItem>
            <Sidebar.MenuButton>
              {#snippet child({ props })}
                <a href="https://docs.ai.hackclub.com" target="_blank" rel="noopener" {...props}>
                  <BookIcon />
                  <span>Documentation</span>
                </a>
              {/snippet}
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

  <Sidebar.Footer>
    <SidebarUser {user} />
  </Sidebar.Footer>
  <Sidebar.Rail />
</Sidebar.Root>
