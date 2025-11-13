type StatCardProps = {
  value: string | number;
  label: string;
};

export const StatCard = ({ value, label }: StatCardProps) => {
  return (
    <div class="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg p-4 transition-colors">
      <div class="text-3xl font-semibold mb-1">{value}</div>
      <div class="text-sm text-gray-600 dark:text-gray-400">{label}</div>
    </div>
  );
};
