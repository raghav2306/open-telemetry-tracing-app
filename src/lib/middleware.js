/**
 * middleware.js — Express middlewares that are "tracing aware".
 *
 * Two kinds of spans appear in Jaeger for every middleware:
 *   1. "middleware - <functionName>"  -> created AUTOMATICALLY by the express
 *      instrumentation (so give your middleware functions real names!)
 *   2. Our own MANUAL spans inside some middlewares (e.g. "auth.verifyToken")
 *
 * In addition, the middlewares ENRICH the HTTP server (root) span of the
 * service with attributes and events: request id, user id, error details...
 */
const crypto = require('node:crypto');
const { trace, SpanStatusCode, withSpan, sleep, jitter } = require('./traced');
const log = require('./logger');

/** An error that carries an HTTP status code. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

/** The HTTP server span of this request (stored by tracing.js requestHook). */
const serverSpan = (req) => req.otelServerSpan || trace.getActiveSpan();

/**
 * 1) requestContext — first middleware in every service.
 *    - assigns/propagates an X-Request-Id
 *    - adds attributes + an event to the server span
 *    - returns the trace id in a response header (copy it into Jaeger search!)
 *    - logs one line per request WITH trace_id (log <-> trace correlation)
 */
function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  const span = serverSpan(req);
  const { traceId } = span.spanContext();

  span.setAttributes({
    'app.request_id': req.id,
    'app.client': req.get('user-agent') || 'unknown',
  });
  span.addEvent('request.received', { 'http.path': req.path });

  res.setHeader('x-request-id', req.id);
  res.setHeader('x-trace-id', traceId);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)} ms)`,
      { request_id: req.id, trace_id: traceId, status: res.statusCode });
  });
  next();
}

/**
 * 2) requireAuth — checks "Authorization: Bearer <token>".
 *    Creates a manual child span "auth.verifyToken" (pretend we call an
 *    identity provider) and tags the server span with the user id.
 */
const VALID_TOKENS = { 'demo-token': 'student-42', 'admin-token': 'teacher-1' };

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  try {
    const userId = await withSpan('auth.verifyToken', { 'auth.scheme': 'bearer' }, async (span) => {
      await sleep(jitter(5, 15)); // simulated call to an identity provider
      if (!token) throw new HttpError(401, 'Missing bearer token');
      const user = VALID_TOKENS[token];
      if (!user) throw new HttpError(401, 'Invalid token');
      span.setAttribute('enduser.id', user);
      return user;
    });
    req.user = userId;
    serverSpan(req).setAttribute('enduser.id', userId);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 3) validate(name, checkFn) — factory for a body-validation middleware.
 *    checkFn(body) returns an array of problems (empty = valid).
 *    Only requests that carry an order (POST, or a demo preset) are checked.
 *    The returned middleware gets a real function name so the express
 *    instrumentation span reads "middleware - validateOrder", etc.
 */
function validate(name, checkFn) {
  const mw = {
    [name]: async (req, res, next) => {
      if (req.method !== 'POST' && !req.demoScenario) return next();
      try {
        await withSpan(`validation.${name}`, { 'validation.fields': Object.keys(req.body || {}).join(',') },
          async (span) => {
            const problems = checkFn(req.body || {});
            span.setAttribute('validation.problem_count', problems.length);
            if (problems.length) {
              span.addEvent('validation.failed', { problems: problems.join('; ') });
              throw new HttpError(400, 'Validation failed', problems);
            }
          });
        next();
      } catch (err) {
        next(err);
      }
    },
  };
  return mw[name];
}

/** 404 for unknown routes. */
function notFound(req, res, next) {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`));
}

/**
 * 4) errorHandler — the LAST middleware (4 arguments = Express error handler).
 *    Records the exception on the server span so the trace turns red in Jaeger,
 *    and returns the trace id to the caller so the failure is easy to find.
 *
 *    Convention (OTel semantic conventions): for SERVER spans only 5xx is an
 *    error; 4xx is the client's fault, so we just add attributes/events.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const span = serverSpan(req);
  const { traceId } = span.spanContext();

  span.setAttributes({ 'app.error': true, 'app.error_message': err.message, 'error.type': err.name });
  if (status >= 500) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  } else {
    span.addEvent('client.error', { 'http.status_code': status, message: err.message });
  }

  log.error(`request failed: ${err.message}`, { request_id: req.id, trace_id: traceId, status });
  res.status(status).json({
    error: err.message,
    details: err.details,
    service: process.env.OTEL_SERVICE_NAME,
    requestId: req.id,
    traceId,
  });
}

module.exports = { HttpError, requestContext, requireAuth, validate, notFound, errorHandler, serverSpan };
