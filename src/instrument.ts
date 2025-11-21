import * as Sentry from "@sentry/bun";

// We can't use ArkType here since this is the first import!
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        sendDefaultPii: true,
        tracesSampleRate: 1.0,
        enableLogs: true,
    });
}