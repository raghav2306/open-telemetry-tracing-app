/**
 * inventory-service (port 3002) — stock checks and reservations.
 *
 * Demo behaviour:
 *   RARE-*    -> cache miss + slow "warehouse" lookup (~1.5 s)  => the SLOW path
 *   SOLDOUT-1 -> 0 in stock => 409 Conflict
 */
const crypto = require('node:crypto');
const { createApp, start } = require('../lib/create-app');
const { HttpError } = require('../lib/middleware');
const { withSpan, traced, sleep, jitter, trace } = require('../lib/traced');

const stock = { 'BOOK-101': 1000, 'PEN-7': 5000, 'RARE-900': 1000, 'SOLDOUT-1': 0 };
const cache = new Map(Object.entries(stock).filter(([sku]) => !sku.startsWith('RARE')));
const reservations = new Map();

// Nested function spans: checkStock -> (cache hit) or (cache miss -> warehouseLookup)
const warehouseLookup = traced('inventory.warehouseLookup', async (sku) => {
  await sleep(jitter(1300, 1700)); // the slow legacy system everybody complains about
  return stock[sku] ?? 0;
}, (sku) => ({ 'inventory.sku': sku, 'peer.service': 'legacy-warehouse' }));

const checkStock = traced('inventory.checkStock', async (sku) => {
  const span = trace.getActiveSpan();
  await sleep(jitter(2, 8)); // simulated cache read
  if (cache.has(sku)) {
    span.addEvent('cache.hit');
    span.setAttribute('inventory.cache_hit', true);
    return cache.get(sku);
  }
  span.addEvent('cache.miss', { reason: 'not cached, asking warehouse' });
  span.setAttribute('inventory.cache_hit', false);
  return warehouseLookup(sku); // NOTE: not cached afterwards, so it stays slow every time
}, (sku) => ({ 'inventory.sku': sku }));

const reserveStock = traced('inventory.reserve', async (sku, qty, orderId) => {
  await sleep(jitter(5, 20)); // simulated UPDATE ... SET qty = qty - ?
  const reservationId = `res_${crypto.randomBytes(4).toString('hex')}`;
  reservations.set(reservationId, { sku, qty, orderId });
  return reservationId;
}, (sku, qty) => ({ 'inventory.sku': sku, 'inventory.qty': qty, 'db.operation': 'UPDATE' }));

const app = createApp((app) => {
  app.post('/inventory/reserve', async (req, res) => {
    const { sku, qty, orderId } = req.body;
    const available = await checkStock(sku);
    req.otelServerSpan?.setAttributes({ 'inventory.sku': sku, 'inventory.available': available });
    if (available < qty) throw new HttpError(409, `Out of stock: ${sku} (available ${available}, requested ${qty})`);
    const reservationId = await reserveStock(sku, qty, orderId);
    res.json({ reservationId, sku, qty });
  });

  app.post('/inventory/release', async (req, res) => {
    await withSpan('inventory.release', { 'inventory.reservation_id': req.body.reservationId }, async (span) => {
      await sleep(jitter(5, 15));
      const found = reservations.delete(req.body.reservationId);
      span.setAttribute('inventory.released', found);
    });
    res.json({ released: req.body.reservationId });
  });
});

start(app, 3002);
