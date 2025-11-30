type IconProps = {
  class?: string;
  title?: string;
  "aria-hidden"?: boolean;
};

export const Warning = ({
  class: className,
  title,
  "aria-hidden": ariaHidden,
}: IconProps) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden={ariaHidden}
    class={className}
  >
    <title>{title}</title>
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    ></path>
  </svg>
);

export const Hamburger = ({
  class: className,
  title,
  "aria-hidden": ariaHidden,
}: IconProps) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden={ariaHidden}
    class={className}
  >
    <title>{title}</title>
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M4 6h16M4 12h16M4 18h16"
    ></path>
  </svg>
);
