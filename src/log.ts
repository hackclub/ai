import pino from "pino";

/**
 * Credential-bearing fields that must never reach a log line (hard rule 6),
 * whichever object they sit in. `*` matches one level of nesting.
 */
const REDACT = [
  "authorization",
  "cookie",
  "apiKey",
  "password",
  "token",
  "*.authorization",
  "*.cookie",
  "*.apiKey",
  "*.password",
  "*.token",
  '*["x-api-key"]',
  "*.headers.authorization",
  "*.headers.cookie",
  '*.headers["x-api-key"]',
];

/**
 * JSON lines on stdout. Pass fields first and the message second, and an
 * error as `err`: `log.error({ err, requestId }, "settlement failed")`.
 * Level from LOG_LEVEL (default info). Pipe through `bunx pino-pretty` to
 * read locally. No transports: they run in worker threads.
 */
export const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: REDACT, censor: "[redacted]" },
};

export const log = pino(loggerOptions);
