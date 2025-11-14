import { DarkModeToggle } from './DarkModeToggle';
import { GlobalStatsButton } from './GlobalStatsButton';
import { Button } from './Button';

type HeaderProps = {
  title: string;
  user: { name: string; avatar?: string };
  showBackToDashboard?: boolean;
  showGlobalStats?: boolean;
};

export const Header = ({ title, user, showBackToDashboard, showGlobalStats }: HeaderProps) => {
  return (
    <header class="border-b border-gray-200 dark:border-gray-700 py-3 sm:py-4 mb-6 sm:mb-8">
      <div class="max-w-6xl mx-auto px-3 sm:px-4 flex justify-between items-center gap-2 sm:gap-4">
        <div class="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <h1 class="text-lg sm:text-xl md:text-2xl font-semibold truncate">{title}</h1>
        </div>
        <div class="flex items-center gap-1.5 sm:gap-2 md:gap-3 flex-shrink-0">
          {showBackToDashboard && (
            <a
              href="/dashboard"
              class="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 px-2 sm:px-3 md:px-4 py-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-xs sm:text-sm transition-colors whitespace-nowrap"
              title="Back to Dashboard"
            >
              <span class="hidden sm:inline">Back to Dashboard</span>
              <span class="sm:hidden">←</span>
            </a>
          )}
          <GlobalStatsButton />
          <DarkModeToggle />
          {user.avatar && <img src={user.avatar} alt={user.name} class="w-8 h-8 rounded-full flex-shrink-0" />}
          <span class="hidden md:inline text-sm truncate max-w-[120px]">{user.name}</span>
          <a
            href="/auth/logout"
            class="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
            title="Logout"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
            </svg>
            <span class="hidden sm:inline text-sm">Logout</span>
          </a>
        </div>
      </div>
    </header>
  );
};
