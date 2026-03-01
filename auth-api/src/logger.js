// Structured JSON logger with automatic OTel trace ID injection.
import { trace, context } from "@opentelemetry/api";

function buildEntry(level, msg, attrs = {}) {
  const span = trace.getSpan(context.active());
  const spanCtx = span?.spanContext();
  const entry = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...attrs,
  };
  if (spanCtx?.traceId) {
    entry.traceId = spanCtx.traceId;
    entry.spanId = spanCtx.spanId;
  }
  return JSON.stringify(entry);
}

const logger = {
  info: (msg, attrs) => process.stdout.write(buildEntry("info", msg, attrs) + "\n"),
  warn: (msg, attrs) => process.stdout.write(buildEntry("warn", msg, attrs) + "\n"),
  error: (msg, attrs) => process.stderr.write(buildEntry("error", msg, attrs) + "\n"),
};

export default logger;
