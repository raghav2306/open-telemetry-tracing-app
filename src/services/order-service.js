/**
 * order-service (port 3001) — orchestrates an order:
 *   1. price the order          (function span: order.calculateTotal)
 *   2. reserve stock            (HTTP call -> inventory-service)
 *   3. charge the card          (HTTP call -> payment-service)
 *      on failure: release the stock again (compensation -> inventory-service)
 *   4. save the order           (function span: order.save, simulated DB)
 */
const crypto = require('node:crypto');
const { createApp, start } = require('../lib/create-app');
const { validate, HttpError } = require('../lib/middleware');
const { withSpan, traced, sleep, jitter } = require('../lib/traced');
const { callService } = require('../lib/http-client');
const log = require('../lib/logger');

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';
const PAYMENT_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003';

const PRICES = { 'BOOK-101': 24.99, 'PEN-7': 2.5, 'RARE-900': 1299.0, 'SOLDOUT-1': 49.0 };
const orders = new Map(); // in-memory "database"

// ---- function-level spans (business logic) --------------------------------

const calculateTotal = traced('order.calculateTotal', async (sku, qty) => {
  await sleep(jitter(3, 10)); // pretend: rules engine / promotions lookup
  const unit = PRICES[sku];
  if (unit === undefined) throw new HttpError(404, `Unknown product ${sku}`);
  const subtotal = unit * qty;
  const tax = +(subtotal * 0.18).toFixed(2); // 18% GST
  return { unit, subtotal, tax, total: +(subtotal + tax).toFixed(2) };
}, (sku, qty) => ({ 'order.sku': sku, 'order.qty': qty }));

const saveOrder = traced('order.save', async (order) => {
  await sleep(jitter(10, 30)); // simulated INSERT
  orders.set(order.id, order);
  return order;
}, () => ({ 'db.system': 'in-memory', 'db.operation': 'INSERT', 'db.collection.name': 'orders' }));

const releaseStock = traced('order.compensate.releaseStock',
  (reservationId, requestId) => callService(INVENTORY_URL, '/inventory/release', { body: { reservationId }, requestId }),
  (reservationId) => ({ 'inventory.reservation_id': reservationId }));

// ---- route handler --------------------------------------------------------

async function createOrder(req, res) {
  const { sku, qty, cardNumber, user } = req.body;
  const orderId = `ord_${crypto.randomBytes(4).toString('hex')}`;
  req.otelServerSpan?.setAttribute('order.id', orderId);

  // A parent span that groups the whole workflow — every step below nests under it.
  const order = await withSpan('order.workflow', { 'order.id': orderId, 'enduser.id': user || 'anonymous' }, async (span) => {
    const price = await calculateTotal(sku, qty);
    span.setAttribute('order.total', price.total);
    span.addEvent('order.priced', { total: price.total, currency: 'INR' });

    const reservation = await callService(INVENTORY_URL, '/inventory/reserve', { body: { sku, qty, orderId }, requestId: req.id });
    span.addEvent('stock.reserved', { 'inventory.reservation_id': reservation.reservationId });

    let payment;
    try {
      payment = await callService(PAYMENT_URL, '/payments/charge',
        { body: { orderId, amount: price.total, cardNumber }, requestId: req.id });
    } catch (err) {
      // Saga-style compensation: undo the reservation. Shows up as an extra
      // call to inventory-service AFTER the failed payment call in the waterfall.
      span.addEvent('payment.failed', { reason: err.message });
      log.warn(`payment failed for ${orderId}, releasing stock`, { order_id: orderId });
      await releaseStock(reservation.reservationId, req.id);
      // 5xx from a dependency => we answer 502 Bad Gateway; 4xx (e.g. declined) passes through.
      throw err.status >= 500 ? new HttpError(502, `Payment service error: ${err.message}`) : err;
    }
    span.addEvent('payment.captured', { 'payment.id': payment.paymentId });

    return saveOrder({ id: orderId, sku, qty, ...price, paymentId: payment.paymentId, status: 'CONFIRMED' });
  });

  res.status(201).json(order);
}

const checkOrder = (b) => (b.sku && Number.isInteger(b.qty) && b.cardNumber ? [] : ['sku, qty and cardNumber are required']);

const app = createApp((app) => {
  app.use('/orders', validate('validateOrderPayload', checkOrder));
  app.post('/orders', createOrder);
  app.get('/orders/:id', (req, res, next) =>
    orders.has(req.params.id) ? res.json(orders.get(req.params.id)) : next(new HttpError(404, 'Order not found')));
});

start(app, 3001);
