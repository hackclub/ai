type StatCardProps = {
  value: string | number;
  label: string;
};

export const StatCard = ({ value, label }: StatCardProps) => {
  return (
    <div class="border-2 border-brand-border bg-white p-6 rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 group">
      <div class="text-4xl font-bold mb-2 text-brand-heading group-hover:scale-105 transition-transform origin-left">{value}</div>
      <div class="text-sm font-medium text-brand-text uppercase tracking-wide">{label}</div>
    </div>
  );
};
