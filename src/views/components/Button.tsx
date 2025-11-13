type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'danger';
  onclick?: string;
  type?: 'button' | 'submit';
  children: any;
  class?: string;
};

export const Button = ({ variant = 'primary', onclick, type = 'button', children, class: className }: ButtonProps) => {
  const baseClasses = 'px-4 py-2 rounded-lg text-sm transition-colors';

  const variantClasses = {
    primary: 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200',
    secondary: 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };

  const classes = `${baseClasses} ${variantClasses[variant]} ${className || ''}`;

  return (
    <button type={type} onclick={onclick} class={classes}>
      {children}
    </button>
  );
};
