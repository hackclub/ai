import { Child } from "hono/jsx";

type CardProps = {
  children: Child;
  class?: string;
};

export const Card = ({ children, class: className }: CardProps) => {
  return (
    <div
      class={`border-2 border-brand-border bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 ${className || ""}`}
    >
      {children}
    </div>
  );
};
