<script lang="ts">
  import DashboardIcon from "remixicon-svelte/icons/dashboard-line";
  import KeyIcon from "remixicon-svelte/icons/key-2-line";
  import CpuIcon from "remixicon-svelte/icons/cpu-line";
  import PulseIcon from "remixicon-svelte/icons/pulse-line";
  import GlobeIcon from "remixicon-svelte/icons/earth-line";
  import BookIcon from "remixicon-svelte/icons/book-open-line";
  import FlaskIcon from "remixicon-svelte/icons/flask-line";
  import BrainIcon from "remixicon-svelte/icons/brain-line";
  import ScanIcon from "remixicon-svelte/icons/scan-line";
  import SearchIcon from "remixicon-svelte/icons/search-line";
  import { page } from "$app/state";
  import * as Sidebar from "#lib/components/ui/sidebar/index.ts";
  import SidebarUser from "#lib/components/layout/sidebar-user.svelte";

  type SidebarUserData = { name: string | null; email: string | null; avatar: string | null };
  let { user }: { user: SidebarUserData } = $props();

  const items = [
    { title: "Dashboard", url: "/dashboard", icon: DashboardIcon },
    { title: "API keys", url: "/keys", icon: KeyIcon },
    { title: "Models", url: "/models", icon: CpuIcon },
    { title: "Activity", url: "/activity", icon: PulseIcon },
    { title: "Replicate", url: "/replicate", icon: FlaskIcon },
    { title: "Jev", url: "/jev", icon: BrainIcon },
    { title: "OCR", url: "/ocr", icon: ScanIcon },
    { title: "Exa", url: "/exa", icon: SearchIcon },
    { title: "Global stats", url: "/global", icon: GlobeIcon },
  ];

  const isActive = (url: string) => page.url.pathname === url || page.url.pathname.startsWith(`${url}/`);
</script>

<Sidebar.Root>
  <Sidebar.Content>
    <Sidebar.Group>
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
