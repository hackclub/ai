type CardProps = {
  children: any;
  class?: string;
};

export const Card = ({ children, class: className }: CardProps) => {
  return (
    <div
      class={`border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg transition-colors ${className || ""}`}
    >
      {children}
    </div>
  );
};
