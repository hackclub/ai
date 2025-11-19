type StatCardProps = {
  value: string | number;
  label: string;
};

export const StatCard = ({ value, label }: StatCardProps) => {
  return (
    <div class="border border-gray-200 dark:border-mocha-surface1 bg-white dark:bg-mocha-surface0 p-4 transition-colors">
      <div class="text-3xl font-semibold mb-1">{value}</div>
      <div class="text-sm text-gray-600 dark:text-mocha-subtext0">{label}</div>
    </div>
  );
};
