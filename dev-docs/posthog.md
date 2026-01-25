# PostHog

PostHog is used for web analytics and feature flags. It helps us understand user behavior and manage feature rollouts.

## Configuration

To set up PostHog, ensure the following environment variables are configured:

- `POSTHOG_API_KEY`: Your PostHog API key.
- `POSTHOG_API_HOST`: The PostHog API host URL.
- `POSTHOG_UI_HOST`: The PostHog UI host URL.

Wait, "API host"?

## Setting up the proxy

PostHog requires a proxy to send requests when people are using adblockers (and considering that this is Hack Club we're talking about, it's safe to say that literally everybody is using one). We host a Cloudflare Workers-based proxy to handle this:

```js
const PROXY_DESTINATION_HOSTNAME = "us.i.posthog.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = PROXY_DESTINATION_HOSTNAME;
    url.protocol = "https";
    const response = await fetch(url.toString(), request);
    return response;
  },
};
```

This is what the `POSTHOG_API_HOST` variable is for. The `POSTHOG_UI_HOST` variable, on the other hand, is still needed for things like the toolbar to work correctly, so set it to `us.posthog.com` or your self-hosted PostHog instance's URL as appropriate.

## Feature flags

As of 25th January 2026, we currently have only one feature flag configured in PostHog:

- `enable_replicate`: Can the user access Replicate-powered features?

Make sure to delete feature flags from PostHog when they're no longer needed to keep things tidy!
