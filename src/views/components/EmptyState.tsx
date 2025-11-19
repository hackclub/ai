type EmptyStateProps = {
  message: string;
};

export const EmptyState = ({ message }: EmptyStateProps) => {
  return (
    <div class="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 transition-colors">
      <p class="text-sm text-gray-600 dark:text-gray-400">{message}</p>
    </div>
  );
};
