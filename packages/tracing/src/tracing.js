// OpenTelemetry tracing bootstrap — MUST be called before importing any other modules.
// This sets up auto-instrumentation for HTTP, Express, and pg.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

let sdk;

/**
 * Initialize OpenTelemetry tracing. Call this at the very top of your entry point,
 * before importing Express or any other library.
 *
 * @param {string} serviceName - e.g. 'auth-api', 'hello-world'
 * @param {object} [options]
 * @param {string} [options.otlpEndpoint] - OTLP HTTP endpoint (default: OTEL_EXPORTER_OTLP_ENDPOINT or http://localhost:4318)
 * @param {string} [options.appInsightsConnectionString] - Azure Application Insights connection string
 */
export function initTracing(serviceName, options = {}) {
  const otlpEndpoint =
    options.otlpEndpoint ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    "http://localhost:4318";

  const appInsightsCs =
    options.appInsightsConnectionString ||
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
  });

  const spanProcessors = [];

  // Always export to Jaeger/OTLP collector
  const otlpExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });
  spanProcessors.push(new BatchSpanProcessor(otlpExporter));

  // Conditionally export to Azure Application Insights
  if (appInsightsCs) {
    import("@azure/monitor-opentelemetry-exporter").then(
      ({ AzureMonitorTraceExporter }) => {
        const azureExporter = new AzureMonitorTraceExporter({
          connectionString: appInsightsCs,
        });
        sdk.addSpanProcessor(new BatchSpanProcessor(azureExporter));
      }
    ).catch((err) => {
      console.warn("[tracing] Failed to load Azure Monitor exporter:", err.message);
    });
  }

  sdk = new NodeSDK({
    resource,
    spanProcessors,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable fs instrumentation (too noisy)
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Configure HTTP instrumentation
        "@opentelemetry/instrumentation-http": {
          headersToSpanAttributes: {
            server: {
              requestHeaders: ["x-request-id"],
              responseHeaders: ["x-request-id"],
            },
            client: {
              requestHeaders: ["x-request-id"],
            },
          },
        },
      }),
    ],
  });

  sdk.start();

  // Graceful shutdown
  const shutdown = () => {
    sdk
      .shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return sdk;
}
