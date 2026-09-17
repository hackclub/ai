<script lang="ts">
  import SunIcon from "remixicon-svelte/icons/sun-line";
  import MoonIcon from "remixicon-svelte/icons/moon-line";
  import { toggleMode } from "mode-watcher";
  import { Button } from "#lib/components/ui/button/index.ts";
</script>

<Button onclick={toggleMode} variant="ghost" size="icon-sm" class="relative">
  <SunIcon class="size-4 scale-100 rotate-0 !transition-all dark:scale-0 dark:-rotate-90" />
  <MoonIcon class="absolute size-4 scale-0 rotate-90 !transition-all dark:scale-100 dark:rotate-0" />
  <span class="sr-only">Toggle theme</span>
</Button>
