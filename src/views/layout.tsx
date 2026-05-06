import { html } from "hono/html";
import type { Child } from "hono/jsx";
import { env } from "../env";
import type { User } from "../types";

type LayoutProps = {
  children: Child;
  title: string;
  includeHtmx?: boolean;
  includeAlpine?: boolean;
  user?: User;
};

export const Layout = ({
  children,
  title,
  includeHtmx = false,
  includeAlpine = false,
  user,
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
              (function () {
                try {
                  var saved = localStorage.getItem("theme");
                  var theme =
                    saved ||
                    (window.matchMedia &&
                    window.matchMedia("(prefers-color-scheme: light)").matches
                      ? "light"
                      : "dark");
                  document.documentElement.dataset.theme = theme;
                } catch (e) {}
              })();

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
                        bg: "rgb(var(--brand-bg) / <alpha-value>)",
                        surface: "rgb(var(--brand-surface) / <alpha-value>)",
                        primary: "#ec3750", // Hack Club Red
                        "primary-hover": "#d62640",
                        heading: "rgb(var(--brand-heading) / <alpha-value>)",
                        text: "rgb(var(--brand-text) / <alpha-value>)",
                        border: "rgb(var(--brand-border) / <alpha-value>)",
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
              :root {
                --brand-bg: 24 24 27;
                --brand-surface: 39 39 42;
                --brand-heading: 250 250 250;
                --brand-text: 212 212 216;
                --brand-border: 48 48 53;
              }
              html[data-theme="light"] {
                --brand-bg: 248 250 252; /* soft white */
                --brand-surface: 255 255 255;
                --brand-heading: 15 23 42; /* slate-900-ish */
                --brand-text: 51 65 85; /* slate-700-ish */
                --brand-border: 226 232 240; /* slate-200-ish */
              }

              html[data-theme="light"] ::selection {
                background: rgba(236, 55, 80, 0.2);
              }

              .theme-icon--sun,
              .theme-icon--moon {
                display: none;
              }
              html[data-theme="light"] .theme-icon--sun {
                display: block;
              }
              html[data-theme="dark"] .theme-icon--moon {
                display: block;
              }

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
          {html`
            <script>
              (function () {
                function getTheme() {
                  return document.documentElement.dataset.theme === "light"
                    ? "light"
                    : "dark";
                }
                function setTheme(theme) {
                  document.documentElement.dataset.theme =
                    theme === "light" ? "light" : "dark";
                  try {
                    localStorage.setItem("theme", getTheme());
                  } catch (e) {}
                }

                window.__setTheme = setTheme;

                document.addEventListener("DOMContentLoaded", function () {
                  document
                    .querySelectorAll("[data-theme-toggle]")
                    .forEach(function (button) {
                      button.addEventListener("click", function () {
                        setTheme(getTheme() === "light" ? "dark" : "light");
                      });
                    });
                });
              })();
            </script>
          `}
          <script
            dangerouslySetInnerHTML={{
              __html: `
                !function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init ss us bi os hs es ns capture Bi calculateEventProperties cs register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty ps vs createPersonProfile gs Zr ys opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing ds debug O fs getPageViewId captureTraceFeedback captureTraceMetric Yr".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
                posthog.init('${env.POSTHOG_API_KEY}', {
                  api_host: '${env.POSTHOG_API_HOST}',
                  ui_host: '${env.POSTHOG_UI_HOST}',
                  defaults: '2025-11-30',
                  person_profiles: 'identified_only',
                });
                ${
                  user
                    ? `posthog.identify('${user.slackId}', {
                    userId: '${user.id}',
                    email: ${user.email ? `'${user.email}'` : "null"},
                    name: ${user.name ? `'${user.name}'` : "null"},
                    isIdvVerified: ${user.isIdvVerified},
                  });`
                    : ""
                }
              `,
            }}
          />
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
