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

export const X = ({ class: className, ...props }: IconProps) => (
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
      d="M6 18L18 6M6 6l12 12"
    />
  </svg>
);

export const AlertTriangle = ({
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

export const Slack = ({ class: className, title }: IconProps) => (
  <svg
    class={className}
    fill="currentColor"
    viewBox="0 0 24 24"
    aria-hidden={title ? undefined : true}
  >
    <title>{title}</title>
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
  </svg>
);

// export const Clipboard = ({
//   class: className,
//   title,
//   "aria-hidden": ariaHidden,
// }: IconProps) => (
//   <svg
//     fill="none"
//     stroke="currentColor"
//     viewBox="0 0 24 24"
//     aria-hidden={ariaHidden}
//     class={className}
//   >
//     <title>{title}</title>
//     <path
//       stroke-linecap="round"
//       stroke-linejoin="round"
//       stroke-width="2"
//       d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
//     ></path>
//   </svg>
// );

// export const Book = ({ class: className, ...props }: IconProps) => (
//   <svg
//     fill="none"
//     stroke="currentColor"
//     viewBox="0 0 24 24"
//     stroke-width="2"
//     class={className}
//     aria-hidden="true"
//     {...props}
//   >
//     <path
//       stroke-linecap="round"
//       stroke-linejoin="round"
//       d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
//     />
//   </svg>
// );
