import { html } from "hono/html";
import type { Child } from "hono/jsx";
import { env } from "../env";

type LayoutProps = {
  children: Child;
  title: string;
  includeHtmx?: boolean;
  includeAlpine?: boolean;
};

export const Layout = ({
  children,
  title,
  includeHtmx = false,
  includeAlpine = false,
}: LayoutProps) => {
  return (
    <>
      {html`<!doctype html>`}
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>{title}</title>
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="icon" type="image/png" href="/favicon.png" />
          <link rel="icon" href="/favicon.ico" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="preconnect"
            href="https://fonts.gstatic.com"
            crossorigin="anonymous"
          />
          <link
            href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&display=swap"
            rel="stylesheet"
          />
          <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
          {includeAlpine && (
            <>
              {/* Alpine plugins must load before Alpine core */}
              <script
                defer
                src="https://unpkg.com/@alpinejs/focus@3.15.2/dist/cdn.min.js"
              />
              <script
                defer
                src="https://unpkg.com/alpinejs@3.15.2/dist/cdn.min.js"
              />
            </>
          )}
          {includeHtmx && (
            <>
              <script src="https://unpkg.com/htmx.org@2.0.8"></script>
              <script src="https://unpkg.com/htmx-ext-json-enc@2.0.1/json-enc.js"></script>
            </>
          )}
          {html`
            <script>
              tailwind.config = {
                theme: {
                  extend: {
                    fontFamily: {
                      sans: [
                        "Google Sans",
                        "ui-sans-serif",
                        "system-ui",
                        "sans-serif",
                      ],
                    },
                    colors: {
                      brand: {
                        bg: "#09090b", // Zinc 950
                        surface: "#18181b", // Zinc 900
                        primary: "#ec3750", // Hack Club Red
                        "primary-hover": "#d62640",
                        heading: "#f4f4f5", // Zinc 100
                        text: "#a1a1aa", // Zinc 400
                        border: "#27272a", // Zinc 800
                      },
                    },
                    borderRadius: {
                      xl: "1rem",
                      "2xl": "1.5rem",
                      "3xl": "2rem",
                    },
                  },
                },
              };
            </script>
          `}
          {html`
            <style>
              @view-transition {
                navigation: auto;
              }
              ::view-transition-old(root),
              ::view-transition-new(root) {
                animation-duration: 100ms;
              }
              [x-cloak] {
                display: none !important;
              }
            </style>
          `}
        </head>
        <body class="bg-brand-bg text-brand-text transition-colors duration-200 min-h-screen flex flex-col">
          {/*<div class="w-full bg-indigo-800 text-white text-center py-2 px-4 text-sm font-semibold">
            New:
          </div>*/}
          {env.NODE_ENV === "development" && (
            <div class="w-full bg-amber-800 text-white text-center py-2 px-4 text-sm font-semibold">
              🛠️ You're in dev mode, go wild!
            </div>
          )}
          {children}
        </body>
      </html>
    </>
  );
};
