import type { Child } from "hono/jsx";

type ModalProps = {
  name: string;
  title: string;
  children: Child;
  class?: string;
};

/**
 * Reusable modal component using Alpine.js
 *
 * Usage:
 * 1. Wrap your page in a div with `x-data` containing your modal states:
 * ```jsx
 *    <div x-data="{ showCreate: false, showDelete: false }">
 * ```
 *
 * 2. Use the `<Modal>` component:
 * ```jsx
 *    <Modal name="showCreate" title="Create Item">
 *      <p>Modal content here</p>
 *    </Modal>
 * ```
 *
 * 3. Open with a button:
 * ```jsx
 *    <button x-on:click="showCreate = true">Open</button>
 * ```
 *
 * 4. Close from inside the modal:
 * ```jsx
 *    <button x-on:click="showCreate = false">Cancel</button>
 * ```
 *
 *    Or use the `$modal.close()` helper if using the store pattern.
 */
export const Modal = ({
  name,
  title,
  children,
  class: className,
}: ModalProps) => {
  return (
    <div
      x-show={name}
      x-transition:enter="transition ease-out duration-100"
      x-transition:enter-start="opacity-0"
      x-transition:enter-end="opacity-100"
      x-transition:leave="transition ease-in duration-100"
      x-transition:leave-start="opacity-100"
      x-transition:leave-end="opacity-0"
      {...{
        "x-trap.inert.noscroll": name,
        "x-on:keydown.escape.window": `${name} = false`,
      }}
      class={`fixed inset-0 bg-brand-heading/20 backdrop-blur-sm z-50 flex items-center justify-center ${className}`}
      style="display: none;"
      role="dialog"
      aria-modal="true"
    >
      <div
        x-show={name}
        x-transition:enter="transition ease-out duration-100"
        x-transition:enter-start="opacity-0 scale-95"
        x-transition:enter-end="opacity-100 scale-100"
        x-transition:leave="transition ease-in duration-100"
        x-transition:leave-start="opacity-100 scale-100"
        x-transition:leave-end="opacity-0 scale-95"
        {...{
          "x-on:click.outside": `${name} = false`,
        }}
        class="bg-brand-surface border-2 border-brand-border p-8 rounded-3xl max-w-xl w-11/12 shadow-2xl"
      >
        <h3 class="text-2xl font-bold mb-4 text-brand-heading select-none">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
};

type ModalActionsProps = {
  children: Child;
};

export const ModalActions = ({ children }: ModalActionsProps) => {
  return <div class="flex justify-end gap-3">{children}</div>;
};

type ModalButtonProps = {
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  /** Modal name to close on click */
  close?: string;
  /** Additional Alpine.js click handler */
  onClick?: string;
  children: Child;
};

export const ModalButton = ({
  variant = "primary",
  type = "button",
  close,
  onClick,
  children,
}: ModalButtonProps) => {
  const baseClasses =
    "px-5 py-2.5 text-sm font-medium transition-all duration-200 rounded-full active:scale-95 select-none hover:tracking-wider";

  const variantClasses = {
    primary: "bg-brand-primary text-white hover:bg-brand-primary-hover",
    secondary:
      "bg-transparent text-brand-text border-2 border-brand-border hover:border-brand-text hover:bg-brand-border/10",
    danger:
      "bg-transparent text-red-500 border-2 border-red-500/30 hover:bg-red-500/10 hover:border-red-500",
  };

  const classes = `${baseClasses} ${variantClasses[variant]}`;

  const clickParts: string[] = [];
  if (close) clickParts.push(`${close} = false`);
  if (onClick) clickParts.push(onClick);
  const clickHandler =
    clickParts.length > 0 ? clickParts.join("; ") : undefined;

  return (
    <button type={type} class={classes} x-on:click={clickHandler}>
      {children}
    </button>
  );
};
