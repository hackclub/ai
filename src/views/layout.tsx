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
                        bg: "#18181b", // Zinc 900
                        surface: "#27272a", // Zinc 800
                        primary: "#ec3750", // Hack Club Red
                        "primary-hover": "#d62640",
                        heading: "#fafafa", // Zinc 50
                        text: "#d4d4d8", // Zinc 300
                        border: "#303035", // Zinc 750 (between 700 and 800)
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
