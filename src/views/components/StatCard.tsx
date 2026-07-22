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
  value?: string | number | null;
  label: string;
};

export const StatCard = ({ value, label }: StatCardProps) => {
  const hasValue = value !== undefined && value !== null;
  const numValue = hasValue
    ? typeof value === "string"
      ? parseInt(value.replace(/,/g, ""), 10)
      : (value as number)
    : NaN;
  const fullValue = hasValue
    ? typeof value === "string"
      ? value
      : typeof value === "number"
        ? value.toLocaleString()
        : String(value)
    : "-";
  const shortValue =
    hasValue && !Number.isNaN(Number(numValue))
      ? formatNumberShort(Number(numValue))
      : fullValue;

  return (
    <div class="border-2 border-brand-border bg-brand-surface p-6 rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 group">
      <div class="text-2xl sm:text-3xl font-bold mb-2 text-brand-heading group-hover:tracking-wide transition-all origin-left">
        <span class="sm:hidden">{shortValue}</span>
        <span class="hidden sm:inline">{fullValue}</span>
      </div>
      <div class="text-xs sm:text-sm font-medium text-brand-text uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
};
