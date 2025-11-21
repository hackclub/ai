import type { User } from "../../types";

type HeaderProps = {
  title: string;
  user: User;
  showBackToDashboard?: boolean;
  showGlobalStats?: boolean;
};

export const Header = ({ title, user, showBackToDashboard }: HeaderProps) => {
  return (
    <header class="py-6 mb-8">
      <div class="max-w-6xl mx-auto px-4 flex justify-between items-center gap-4">
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
        <div class="flex items-center gap-6">
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
            <a
              href="/auth/logout"
              class="text-sm font-medium text-red-500 hover:text-red-600 ml-2"
            >
              Logout
            </a>
          </div>
        </div>
      </div>
    </header>
  );
};
