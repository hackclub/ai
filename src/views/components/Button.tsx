import type { Child } from "hono/jsx";

type ButtonProps = {
  variant?: "primary" | "secondary" | "danger";
  onclick?: string;
  type?: "button" | "submit";
  children: Child;
  class?: string;
};

export const Button = ({
  variant = "primary",
  onclick,
  type = "button",
  children,
  class: className,
}: ButtonProps) => {
  const baseClasses =
    "px-5 py-2.5 text-sm font-medium transition-all duration-200 rounded-full active:scale-95";

  const variantClasses = {
    primary:
      "bg-brand-primary text-white hover:bg-brand-primary-hover hover:-translate-y-0.5",
    secondary:
      "bg-transparent text-brand-text border-2 border-brand-border hover:border-brand-text hover:bg-brand-border/10",
    danger:
      "bg-transparent text-red-500 border-2 border-red-500/30 hover:bg-red-500/10 hover:border-red-500",
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${className || ""}`;

  return (
    <button type={type} onclick={onclick} class={classes}>
      {children}
    </button>
  );
};
