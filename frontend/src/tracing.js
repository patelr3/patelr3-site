// Browser-side OpenTelemetry tracing — auto-instruments fetch calls to /api/*
// and propagates W3C traceparent headers so browser spans link to backend traces.
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { registerInstrumentations } from "@opentelemetry/instrumentation";

const provider = new WebTracerProvider({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: "frontend",
  }),
});

// Export traces to the OTLP collector via nginx proxy (/otlp/)
const exporter = new OTLPTraceExporter({
  url: "/otlp/v1/traces",
});

provider.addSpanProcessor(new BatchSpanProcessor(exporter));
provider.register({
  contextManager: new ZoneContextManager(),
});

// Auto-instrument fetch and XHR for /api/* calls
registerInstrumentations({
  instrumentations: [
    new FetchInstrumentation({
      propagateTraceHeaderCorsUrls: [/\/api\/.*/],
      clearTimingResources: true,
    }),
    new XMLHttpRequestInstrumentation({
      propagateTraceHeaderCorsUrls: [/\/api\/.*/],
    }),
  ],
});

export default provider;
