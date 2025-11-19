type EmptyStateProps = {
  message: string;
};

export const EmptyState = ({ message }: EmptyStateProps) => {
  return (
    <div class="border border-gray-200 bg-white p-6 transition-colors">
      <p class="text-sm text-gray-600">{message}</p>
    </div>
  );
};
