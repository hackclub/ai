type EmptyStateProps = {
  message: string;
};

export const EmptyState = ({ message }: EmptyStateProps) => {
  return (
    <div class="border border-gray-200 dark:border-mocha-surface1 bg-white dark:bg-mocha-surface0 p-6 transition-colors">
      <p class="text-sm text-gray-600 dark:text-mocha-subtext0">{message}</p>
    </div>
  );
};
