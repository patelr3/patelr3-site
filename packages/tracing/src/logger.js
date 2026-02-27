// Structured logging with pino, enriched with OpenTelemetry trace context.
import pino from "pino";
import { context, trace } from "@opentelemetry/api";

/**
 * Create a pino logger that automatically includes trace context (traceId, spanId)
 * in every log line.
 *
 * @param {string} serviceName - e.g. 'auth-api', 'hello-world'
 * @param {object} [options] - Additional pino options
 * @returns {import('pino').Logger}
 */
export function createLogger(serviceName, options = {}) {
  return pino({
    name: serviceName,
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      log(obj) {
        const span = trace.getSpan(context.active());
        if (span) {
          const spanContext = span.spanContext();
          obj.traceId = spanContext.traceId;
          obj.spanId = spanContext.spanId;
        }
        return obj;
      },
    },
    // Use pino-pretty only when explicitly requested via LOG_PRETTY=true.
    // In Docker containers, the pino-pretty module may not be resolvable.
    transport:
      process.env.LOG_PRETTY === "true"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    ...options,
  });
}
