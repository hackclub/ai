import { html } from "hono/html";
import type { User } from "../../types";
import { Hamburger } from "./Icons";

type HeaderProps = {
  title: string;
  user: User;
  showBackToDashboard?: boolean;
  showGlobalStats?: boolean;
};

export const Header = ({ title, user, showBackToDashboard }: HeaderProps) => {
  return (
    <header class="py-6 sm:mb-8 relative z-50">
      <div class="max-w-7xl mx-auto px-4 flex justify-between items-center gap-4">
        <a href="/dashboard">
          <div class="flex items-center gap-3 flex-shrink-0">
            <div class="w-10 h-10 bg-brand-primary rounded-xl flex items-center justify-center text-white font-bold text-xl transform -rotate-3">
              h
            </div>
            <h1 class="text-2xl md:text-3xl font-bold text-brand-heading tracking-tight">
              {title}
            </h1>
          </div>
        </a>

        {/* Desktop Navigation */}
        <div class="hidden md:flex items-center gap-6">
          {showBackToDashboard && (
            <a
              href="/dashboard"
              class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
            >
              Back to Dashboard
            </a>
          )}
          <a
            href="https://hackclub.slack.com/archives/C099S1LLFFU"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Support/Bug Reports
          </a>
          <a
            href="/docs"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Docs
          </a>
          <a
            href="/global"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Global Stats
          </a>
          <div class="flex items-center gap-3 pl-6 border-l-2 border-brand-border">
            <span class="text-sm font-medium text-brand-heading">
              {user.name || "User"}
            </span>
            {user.avatar && (
              <img
                src={user.avatar || undefined}
                alt={user.name || "User"}
                class="w-10 h-10 rounded-full border-2 border-brand-border"
              />
            )}
            <form action="/auth/logout" method="post" class="inline">
              <button
                type="submit"
                class="text-sm font-medium text-red-500 hover:text-red-600 ml-2 cursor-pointer"
              >
                Logout
              </button>
            </form>
          </div>
        </div>

        {/* Mobile Menu Button */}
        <button
          id="mobile-menu-toggle"
          class="md:hidden p-2 text-brand-text hover:text-brand-primary transition-colors"
          aria-label="Toggle menu"
          type="button"
        >
          <Hamburger title="Toggle menu" />
        </button>
      </div>

      {/* Mobile Menu Dropdown */}
      <div
        id="mobile-menu"
        class="hidden md:hidden absolute top-full left-0 right-0 bg-brand-surface border-b-2 border-brand-border shadow-xl p-4 flex flex-col gap-4"
      >
        {showBackToDashboard && (
          <a
            href="/dashboard"
            class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
          >
            Back to Dashboard
          </a>
        )}
        <a
          href="https://hackclub.slack.com/archives/C099S1LLFFU"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Support/Bug Reports
        </a>
        <a
          href="/docs"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Docs
        </a>
        <a
          href="/global"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Global Stats
        </a>

        <div class="h-px bg-brand-border my-1"></div>

        <div class="flex items-center gap-3 px-2">
          {user.avatar && (
            <img
              src={user.avatar || undefined}
              alt={user.name || "User"}
              class="w-8 h-8 rounded-full border-2 border-brand-border"
            />
          )}
          <span class="text-base font-medium text-brand-heading">
            {user.name || "User"}
          </span>
        </div>

        <form action="/auth/logout" method="post">
          <button
            type="submit"
            class="text-base font-medium text-red-500 hover:text-red-600 px-2 cursor-pointer"
          >
            Logout
          </button>
        </form>
      </div>

      {html`
        <script>
          document.getElementById('mobile-menu-toggle').addEventListener('click', function() {
            const menu = document.getElementById('mobile-menu');
            menu.classList.toggle('hidden');
          });
        </script>
      `}
    </header>
  );
};
