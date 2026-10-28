/**
 * tracing.js — OpenTelemetry bootstrap. Loaded BEFORE the app with:
 *
 *     node --require ./src/tracing.js src/services/<service>.js
 *
 * Why --require? Auto-instrumentation works by patching modules (http, express,
 * undici/fetch...) at the moment they are first `require`d. If the SDK starts
 * after express is already loaded, express will NOT be traced.
 *
 * Configuration comes from standard OTel environment variables:
 *   OTEL_SERVICE_NAME            -> name shown in Jaeger's "Service" dropdown
 *   OTEL_EXPORTER_OTLP_ENDPOINT  -> where to send spans (Jaeger's OTLP/HTTP port 4318)
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'unknown-service';
const otlpBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

// 1) Exporter: ships finished spans to Jaeger over OTLP/HTTP (protobuf-free JSON).
const traceExporter = new OTLPTraceExporter({ url: `${otlpBase}/v1/traces` });

// 2) Resource: attributes attached to EVERY span from this process.
//    Visible in Jaeger under "Process" when you expand a span.
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: '1.0.0',
  'deployment.environment': process.env.DEPLOY_ENV || 'lab',
});

// 3) Auto-instrumentation: http (server + client), express (one span per
//    middleware / route handler), undici (global fetch) and more.
const instrumentations = getNodeAutoInstrumentations({
  // fs / dns / net spans are noisy and distract from the lesson — switch them off.
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-dns': { enabled: false },
  '@opentelemetry/instrumentation-net': { enabled: false },
  // Express 5 runs on the 'router' package. Its instrumentation duplicates the
  // express spans (you'd see "middleware - patched"), so we keep only express.
  '@opentelemetry/instrumentation-router': { enabled: false },
  '@opentelemetry/instrumentation-http': {
    // Don't trace Kubernetes/Docker health probes — they would flood Jaeger.
    ignoreIncomingRequestHook: (req) => req.url === '/health',
    // Keep a handle on the HTTP *server* (root) span of each request so our
    // Express middlewares can enrich it later (see lib/middleware.js).
    requestHook: (span, req) => {
      if (req.constructor && req.constructor.name === 'IncomingMessage') {
        req.otelServerSpan = span;
      }
    },
  },
});

const sdk = new NodeSDK({ resource, traceExporter, instrumentations });
sdk.start();
console.log(`[tracing] OpenTelemetry started for "${serviceName}" -> ${otlpBase}`);

// Flush buffered spans on shutdown (docker stop / kubectl delete send SIGTERM).
const shutdown = () =>
  sdk.shutdown()
    .then(() => console.log('[tracing] SDK shut down, spans flushed'))
    .catch((err) => console.error('[tracing] shutdown error', err))
    .finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
