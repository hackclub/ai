type CardProps = {
  children: any;
  class?: string;
};

export const Card = ({ children, class: className }: CardProps) => {
  return (
    <div
      class={`border border-gray-200 dark:border-mocha-surface1 bg-white dark:bg-mocha-surface0 transition-colors ${className || ""}`}
    >
      {children}
    </div>
  );
};
