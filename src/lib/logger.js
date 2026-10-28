/**
 * logger.js — tiny JSON logger that stamps every line with the current
 * trace_id / span_id. With these ids you can jump from a log line (e.g. in
 * Kibana / EFK) straight to the matching trace in Jaeger.
 */
const { trace } = require('@opentelemetry/api');

function write(level, message, extra = {}) {
  const ctx = trace.getActiveSpan()?.spanContext();
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: process.env.OTEL_SERVICE_NAME,
    message,
    trace_id: ctx?.traceId,
    span_id: ctx?.spanId,
    ...extra,
  }));
}

module.exports = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};
