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
      "bg-white text-brand-text border-2 border-brand-border hover:border-brand-text/30 hover:bg-brand-bg",
    danger:
      "bg-white text-red-500 border-2 border-red-100 hover:bg-red-50 hover:border-red-200",
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${className || ""}`;

  return (
    <button type={type} onclick={onclick} class={classes}>
      {children}
    </button>
  );
};
