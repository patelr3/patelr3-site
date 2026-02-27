// Express middleware for request ID propagation and HTTP request logging.
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { context, trace } from "@opentelemetry/api";

/**
 * Creates Express middleware that:
 * 1. Generates or reads X-Request-Id header
 * 2. Attaches request ID as an OpenTelemetry span attribute
 * 3. Logs every HTTP request/response with pino
 *
 * @param {import('pino').Logger} logger - pino logger instance
 * @returns {import('express').RequestHandler}
 */
export function requestIdMiddleware(logger) {
  return (req, res, next) => {
    const requestId = req.headers["x-request-id"] || randomUUID();
    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);

    // Attach request ID to the current OTel span
    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttribute("http.request_id", requestId);
    }

    next();
  };
}

/**
 * Creates pino-http middleware for structured HTTP request logging.
 *
 * @param {import('pino').Logger} logger - pino logger instance
 * @returns {import('express').RequestHandler}
 */
export function httpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id || req.headers["x-request-id"] || randomUUID(),
    customProps: (req) => {
      const span = trace.getSpan(context.active());
      const props = {};
      if (span) {
        const spanContext = span.spanContext();
        props.traceId = spanContext.traceId;
        props.spanId = spanContext.spanId;
      }
      return props;
    },
    // Don't log health check endpoints to reduce noise
    autoLogging: {
      ignore: (req) => req.url === "/health" || req.url === "/healthz",
    },
  });
}
