import winston from "winston";
import { v4 as uuidv4 } from "uuid";

const { combine, timestamp, json, errors, printf } = winston.format;

const structuredFormat = printf(({ level, message, timestamp, correlationId, ...meta }) => {
  return JSON.stringify({
    timestamp,
    level,
    correlationId: correlationId || undefined,
    message,
    ...meta,
  });
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "ISO" }),
    json(),
    structuredFormat,
  ),
  defaultMeta: {
    service: "noblepay-api",
    version: "1.0.0",
  },
  transports: [
    new winston.transports.Console({
      silent: process.env.NODE_ENV === "test",
    }),
  ],
});

if (process.env.LOG_FILE === "true") {
  logger.add(
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  );
  logger.add(
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 50 * 1024 * 1024,
      maxFiles: 10,
    }),
  );
}

/** Generate a unique correlation ID for request tracing */
export function generateCorrelationId(): string {
  return uuidv4();
}

/** Create a child logger bound to a specific correlation ID */
export function createRequestLogger(correlationId: string) {
  return logger.child({ correlationId });
}

export type RequestLogger = ReturnType<typeof createRequestLogger>;
