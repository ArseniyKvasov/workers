import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger, LoggerOptions };

/** Keys whose values must never appear in logs. */
const REDACT_PATHS = [
  "secrets",
  "*.password",
  "*.password_hash",
  "*.token",
  "*.api_key",
  "*.client_secret",
  "*.encrypted_value",
  "headers.authorization",
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: REDACT_PATHS,
    base: { service: process.env.SERVICE_NAME ?? "workers-platform" },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  });
}

/** Mask any secret-looking substring inside a free-form message. */
export function maskSecrets(msg: string, secretValues: Iterable<string>): string {
  let result = msg;
  for (const value of secretValues) {
    if (value.length >= 8) {
      result = result.split(value).join("[REDACTED]");
    }
  }
  return result;
}
