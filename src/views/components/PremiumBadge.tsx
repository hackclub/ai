type PremiumBadgeProps = {
  hasAccess?: boolean;
  size?: "sm" | "md";
};

export const PremiumBadge = ({ hasAccess, size = "sm" }: PremiumBadgeProps) => {
  const sizeClasses = size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";

  if (hasAccess) {
    return (
      <span
        class={`${sizeClasses} font-medium rounded-full bg-green-500/10 text-green-400 border border-green-500/20`}
      >
        Unlocked
      </span>
    );
  }

  return (
    <span
      class={`${sizeClasses} font-medium rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20`}
    >
      Premium
    </span>
  );
};
