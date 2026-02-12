import { html } from "hono/html";
import type { User } from "../../types";
import { Hamburger } from "./Icons";

type HeaderProps = {
  title: string;
  user: User;
  replicateEnabled?: boolean;
  dailySpending?: number;
  dailyLimit?: number;
};

export const Header = ({
  title,
  user,
  replicateEnabled,
  dailySpending,
  dailyLimit,
}: HeaderProps) => {
  const limit = dailyLimit ?? parseFloat(user.spendingLimitUsd || "8");
  const spent = dailySpending ?? 0;
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
          <a
            href="/keys"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Keys
          </a>
          <a
            href="/models"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Models
          </a>
          <a
            href="/activity"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Activity
          </a>
          <a
            href="/docs"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Docs
          </a>
          {replicateEnabled && (
            <a
              href="/replicate"
              class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
            >
              Replicate
            </a>
          )}
          <a
            href="/global"
            class="text-sm font-medium text-brand-text hover:text-brand-primary transition-colors"
          >
            Global Stats
          </a>
          {dailySpending !== undefined && (
            <div class="flex items-center gap-2 px-3 py-1.5 bg-brand-surface border border-brand-border rounded-full">
              <div class="w-2 h-2 rounded-full bg-green-500"></div>
              <span class="text-xs font-medium text-brand-text">
                ${spent.toFixed(2)}/${limit.toFixed(2)}
              </span>
            </div>
          )}
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
          <Hamburger class="w-6 h-6" title="Toggle menu" />
        </button>
      </div>

      {/* Mobile Menu Dropdown */}
      <div
        id="mobile-menu"
        class="hidden md:hidden absolute top-full left-0 right-0 bg-brand-surface border-b-2 border-brand-border shadow-xl p-4 flex flex-col gap-4"
      >
        <a
          href="/keys"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Keys
        </a>
        <a
          href="/models"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Models
        </a>
        <a
          href="/activity"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Activity
        </a>
        <a
          href="/docs"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Docs
        </a>
        {replicateEnabled && (
          <a
            href="/replicate"
            class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
          >
            Replicate
          </a>
        )}
        <a
          href="/global"
          class="text-base font-medium text-brand-text hover:text-brand-primary transition-colors px-2"
        >
          Global Stats
        </a>

        {dailySpending !== undefined && (
          <div class="flex items-center gap-2 px-2 py-2">
            <div class="flex items-center gap-2 px-3 py-1.5 bg-brand-surface border border-brand-border rounded-full">
              <div class="w-2 h-2 rounded-full bg-green-500"></div>
              <span class="text-xs font-medium text-brand-text">
                ${spent.toFixed(2)}/${limit.toFixed(2)}
              </span>
            </div>
          </div>
        )}

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
          document
            .getElementById("mobile-menu-toggle")
            .addEventListener("click", function () {
              const menu = document.getElementById("mobile-menu");
              menu.classList.toggle("hidden");
            });
        </script>
      `}
    </header>
  );
};
