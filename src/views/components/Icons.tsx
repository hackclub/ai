type IconProps = {
  class?: string;
  title?: string;
  "aria-hidden"?: boolean;
  "x-bind:class"?: string;
  "x-show"?: string;
  "x-cloak"?: boolean;
} & Record<`x-${string}`, string | boolean | undefined>;

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

export const ChevronDown = ({ class: className, ...props }: IconProps) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    stroke-width="2"
    class={className}
    aria-hidden="true"
    {...props}
  >
    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

export const Copy = ({ class: className, ...props }: IconProps) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    stroke-width="2"
    class={className}
    aria-hidden="true"
    {...props}
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
    />
  </svg>
);

export const Check = ({ class: className, ...props }: IconProps) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    stroke-width="2"
    class={className}
    aria-hidden="true"
    {...props}
  >
    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

export const Clipboard = ({
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
      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
    ></path>
  </svg>
);
