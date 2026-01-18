function formatNumberShort(num: number): string {
  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return num.toString();
}

type StatCardProps = {
  value: string | number;
  label: string;
};

export const StatCard = ({ value, label }: StatCardProps) => {
  const numValue =
    typeof value === "string" ? parseInt(value.replace(/,/g, ""), 10) : value;
  const fullValue = typeof value === "string" ? value : value.toLocaleString();
  const shortValue = Number.isNaN(numValue)
    ? value
    : formatNumberShort(numValue);

  return (
    <div class="border-2 border-brand-border bg-brand-surface p-6 rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 group">
      <div class="text-2xl sm:text-4xl font-bold mb-2 text-brand-heading group-hover:tracking-wide transition-all origin-left">
        <span class="sm:hidden">{shortValue}</span>
        <span class="hidden sm:inline">{fullValue}</span>
      </div>
      <div class="text-xs sm:text-sm font-medium text-brand-text uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
};
