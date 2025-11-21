type EmptyStateProps = {
  message: string;
};

export const EmptyState = ({ message }: EmptyStateProps) => {
  return (
    <div class="border-2 border-brand-border bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-300">
      <p class="text-brand-text font-medium">{message}</p>
    </div>
  );
};
