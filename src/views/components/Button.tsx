type ButtonProps = {
  variant?: "primary" | "secondary" | "danger";
  onclick?: string;
  type?: "button" | "submit";
  children: any;
  class?: string;
};

export const Button = ({
  variant = "primary",
  onclick,
  type = "button",
  children,
  class: className,
}: ButtonProps) => {
  const baseClasses = "px-4 py-2 text-sm transition-colors";

  const variantClasses = {
    primary:
      "bg-gray-900 dark:bg-mocha-text text-white dark:text-mocha-base hover:bg-gray-700 dark:hover:bg-mocha-text",
    secondary:
      "bg-white dark:bg-mocha-surface0 text-gray-900 dark:text-mocha-text border border-gray-200 dark:border-mocha-surface1 hover:bg-gray-100 dark:hover:bg-mocha-surface1",
    danger: "text-gray-900 dark:text-mocha-text border border-gray-200 dark:border-mocha-surface1 hover:bg-gray-100 dark:hover:bg-mocha-surface1",
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${className || ""}`;

  return (
    <button type={type} onclick={onclick} class={classes}>
      {children}
    </button>
  );
};
