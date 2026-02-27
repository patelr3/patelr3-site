// @patelr3/tracing — shared OpenTelemetry + pino setup for all services
export { initTracing } from "./tracing.js";
export { createLogger } from "./logger.js";
export { requestIdMiddleware, httpLogger } from "./middleware.js";

// Re-export commonly used OTel API symbols so services don't need @opentelemetry/api directly
export { trace, context, SpanStatusCode } from "@opentelemetry/api";
