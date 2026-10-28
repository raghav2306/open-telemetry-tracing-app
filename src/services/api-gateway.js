/**
 * api-gateway (port 3000) — the public entry point.
 *
 *   client ──► api-gateway ──► order-service ──► inventory-service
 *                                         └────► payment-service
 *
 * Routes
 *   POST /api/orders            place an order (JSON body: sku, qty, cardNumber)
 *   GET  /api/demo/:scenario    preset orders: happy | slow | error | declined | invalid | soldout
 * Both need:  Authorization: Bearer demo-token
 */
const { createApp, start } = require('../lib/create-app');
const { requireAuth, validate, HttpError } = require('../lib/middleware');
const { traced } = require('../lib/traced');
const { callService } = require('../lib/http-client');

const ORDER_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3001';

// Preset request bodies for the lab scenarios.
const SCENARIOS = {
  happy:    { sku: 'BOOK-101', qty: 2, cardNumber: '4111111111111111' }, // everything fast & green
  slow:     { sku: 'RARE-900', qty: 1, cardNumber: '4111111111111111' }, // slow warehouse lookup in inventory
  error:    { sku: 'BOOK-101', qty: 1, cardNumber: '4000000000000119' }, // payment processor crashes (5xx)
  declined: { sku: 'BOOK-101', qty: 1, cardNumber: '4000000000000002' }, // card declined (402, business error)
  soldout:  { sku: 'SOLDOUT-1', qty: 1, cardNumber: '4111111111111111' }, // out of stock (409)
  invalid:  { sku: '', qty: 0 },                                           // rejected by validation (400)
};

// Validation rules for an order body (used by the validate() middleware).
const checkOrder = (b) => {
  const problems = [];
  if (!b.sku || typeof b.sku !== 'string') problems.push('sku is required');
  if (!Number.isInteger(b.qty) || b.qty < 1 || b.qty > 10) problems.push('qty must be an integer 1..10');
  if (!/^\d{16}$/.test(b.cardNumber || '')) problems.push('cardNumber must be 16 digits');
  return problems;
};

// Function-level span: forwarding to the order service.
// Notice in Jaeger: this span is the PARENT of the auto-instrumented HTTP "POST" client span.
const forwardOrder = traced('gateway.forwardOrder',
  (order, requestId, user) => callService(ORDER_URL, '/orders', { body: { ...order, user }, requestId }),
  (order) => ({ 'order.sku': order.sku, 'order.qty': order.qty }));

// Named middleware => Jaeger shows "middleware - loadDemoPayload".
function loadDemoPayload(req, res, next) {
  const preset = SCENARIOS[req.params.scenario];
  if (!preset) return next(new HttpError(404, `Unknown scenario "${req.params.scenario}". Try: ${Object.keys(SCENARIOS).join(', ')}`));
  req.body = { ...preset };
  req.demoScenario = req.params.scenario;
  req.otelServerSpan?.setAttribute('demo.scenario', req.params.scenario);
  next();
}

async function placeOrder(req, res) {
  const result = await forwardOrder(req.body, req.id, req.user);
  res.status(201).json(result);
}

// Middlewares are mounted with app.use() so the express instrumentation shows
// each one by NAME in Jaeger: "middleware - requireAuth", "middleware - validateOrder", ...
// (handlers passed directly to app.get/app.post all show up as "request handler - <route>").
const app = createApp((app) => {
  app.use('/api', requireAuth);
  app.use('/api/demo/:scenario', loadDemoPayload);
  app.use('/api', validate('validateOrder', checkOrder));
  app.post('/api/orders', placeOrder);
  app.get('/api/demo/:scenario', placeOrder);
});

start(app, 3000);
