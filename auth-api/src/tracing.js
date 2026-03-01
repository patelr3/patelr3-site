// OpenTelemetry SDK initialization — must be imported FIRST (before Express).
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";

let traceExporter;
const connStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connStr) {
  const mod = await import("@azure/monitor-opentelemetry-exporter");
  const AzureMonitorTraceExporter = mod.AzureMonitorTraceExporter;
  traceExporter = new AzureMonitorTraceExporter({ connectionString: connStr });
  console.log("[tracing] Azure Monitor exporter configured");
} else {
  traceExporter = new ConsoleSpanExporter();
  console.log("[tracing] Console exporter (no APPLICATIONINSIGHTS_CONNECTION_STRING)");
}

const sdk = new NodeSDK({
  serviceName: "auth-api",
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Only enable instrumentations we actually use
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: true },
      // Disable noisy/unused ones
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    }),
  ],
});

sdk.start();

// Graceful shutdown
process.on("SIGTERM", () => sdk.shutdown().catch(console.error));
process.on("SIGINT", () => sdk.shutdown().catch(console.error));

// Re-export OTel API for manual instrumentation
export { trace, context, SpanStatusCode } from "@opentelemetry/api";
