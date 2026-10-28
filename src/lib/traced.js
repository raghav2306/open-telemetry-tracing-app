/**
 * traced.js — helpers for MANUAL (function-level) spans.
 *
 * Auto-instrumentation only sees the edges of a service (incoming HTTP,
 * outgoing HTTP, express middlewares). It cannot see *business logic* such as
 * "calculate total" or "fraud check". These helpers make that logic visible.
 *
 *   withSpan(name, attrs, fn)   -> run fn inside a new child span
 *   traced(name, fn, attrsFn)   -> "decorator": wraps a function so EVERY call is a span
 *   sleep(ms)                   -> simulated latency (DB / network / CPU work)
 */
const { trace, SpanStatusCode } = require('@opentelemetry/api');

// One tracer per service. The name shows up as "otel.scope.name" on each span.
const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME || 'demo', '1.0.0');

/**
 * Run `fn(span)` inside a new active span. Any span created inside `fn`
 * (including auto-instrumented HTTP calls) automatically becomes its child.
 * Errors are recorded on the span, the status is set to ERROR, and re-thrown.
 */
async function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err); // adds an "exception" event with message + stack
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.setAttribute('error.type', err.name || 'Error');
      throw err;
    } finally {
      span.end(); // ALWAYS end the span, otherwise it is never exported
    }
  });
}

/**
 * Decorator-style wrapper (JavaScript has no stable @decorators in Node yet,
 * so we use a higher-order function):
 *
 *   const calculateTotal = traced('order.calculateTotal', async (items) => {...},
 *                                 (items) => ({ 'order.item_count': items.length }));
 *
 * `attrsFn` receives the same arguments and returns span attributes.
 */
function traced(name, fn, attrsFn = () => ({})) {
  return async function tracedFunction(...args) {
    return withSpan(name, { 'code.function': fn.name || name, ...attrsFn(...args) },
      () => fn(...args));
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random integer in [min, max] — used for realistic-looking jitter. */
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

module.exports = { tracer, withSpan, traced, sleep, jitter, trace, SpanStatusCode };
