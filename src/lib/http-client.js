/**
 * http-client.js — calls another service with fetch().
 *
 * Nothing tracing-specific is needed here: the undici instrumentation
 * (fetch) creates a CLIENT span and injects the W3C "traceparent" header,
 * so the downstream service continues THE SAME trace. That header is the
 * whole secret of distributed tracing — try logging req.headers.traceparent
 * in a downstream service to see it.
 */
const { HttpError } = require('./middleware');

async function callService(baseUrl, path, { method = 'POST', body, requestId } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(requestId && { 'x-request-id': requestId }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Network failure / timeout: the downstream service is unreachable.
    throw new HttpError(503, `Cannot reach ${baseUrl}${path}: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new HttpError(res.status, data.error || `HTTP ${res.status} from ${path}`, data.details);
    e.upstream = data.service;
    throw e;
  }
  return data;
}

module.exports = { callService };
