import { Warning, X } from "./Icons";

export const AgentBanner = () => {
  return (
    <div
      id="agent-banner"
      class="bg-amber-100 border-l-4 border-amber-500 mx-4 mt-4"
    >
      <div class="max-w-7xl mx-auto px-4 py-4">
        <div class="flex items-center gap-4">
          <Warning
            class="w-6 h-6 text-amber-600 flex-shrink-0"
            aria-hidden
          />
          <div class="flex-1">
            <h3 class="text-sm font-semibold text-amber-900">
              Not for AI coding agents
            </h3>
            <p class="text-sm text-amber-800 mt-1">
              hackai cannot be used with AI coding agents like OpenClaw, Claude
              Code, Cursor, Cline, or any other coding agent. Requests from
              these tools will be blocked. Join{" "}
              <code class="font-mono">#hackclub-ai</code> on the Hack Club Slack
              for updates.
            </p>
          </div>
          <button
            type="button"
            hx-post="/api/dismiss-agent-banner"
            hx-target="#agent-banner"
            hx-swap="outerHTML"
            class="flex-shrink-0 p-1.5 text-amber-900 hover:bg-amber-200 rounded-full transition-colors"
            aria-label="Dismiss banner"
          >
            <X class="w-5 h-5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
};
