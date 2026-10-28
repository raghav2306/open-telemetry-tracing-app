/**
 * payment-service (port 3003) — fraud check + card charge.
 *
 * Demo test cards (like Stripe's test numbers):
 *   4111111111111111  -> success
 *   4000000000000002  -> declined           (402, business error: span error, but not a server failure)
 *   4000000000000119  -> processor crash    (500 after a long wait => the ERROR path)
 */
const crypto = require('node:crypto');
const { createApp, start } = require('../lib/create-app');
const { HttpError } = require('../lib/middleware');
const { traced, sleep, jitter, trace } = require('../lib/traced');

class PaymentDeclinedError extends HttpError {
  constructor(msg) { super(402, msg); this.name = 'PaymentDeclinedError'; }
}
class ProcessorError extends HttpError {
  constructor(msg) { super(500, msg); this.name = 'ProcessorError'; }
}

// Never put full card numbers in spans/logs! Only the last 4 digits.
const last4 = (card) => String(card).slice(-4);

const fraudCheck = traced('payment.fraudCheck', async (amount, card) => {
  await sleep(jitter(10, 40)); // simulated ML scoring
  const score = Math.min(0.99, +(amount / 10000 + Math.random() * 0.1).toFixed(2));
  const span = trace.getActiveSpan();
  span.setAttribute('payment.fraud_score', score);
  if (score > 0.1) span.addEvent('fraud.review_suggested', { score });
  return score;
}, (amount, card) => ({ 'payment.amount': amount, 'payment.card_last4': last4(card) }));

const chargeCard = traced('payment.chargeCard', async (amount, card) => {
  const span = trace.getActiveSpan();
  span.addEvent('bank.request.sent');
  if (card.endsWith('0119')) {
    await sleep(jitter(700, 900)); // the bank hangs ...
    throw new ProcessorError('Card processor timeout (simulated bank outage)');
  }
  await sleep(jitter(60, 150)); // simulated call to the bank
  if (card.endsWith('0002')) throw new PaymentDeclinedError('Card declined: insufficient funds');
  span.addEvent('bank.response.received', { approved: true });
  return `pay_${crypto.randomBytes(4).toString('hex')}`;
}, (amount, card) => ({ 'payment.amount': amount, 'payment.card_last4': last4(card), 'peer.service': 'acme-bank' }));

const app = createApp((app) => {
  app.post('/payments/charge', async (req, res) => {
    const { orderId, amount, cardNumber } = req.body;
    req.otelServerSpan?.setAttributes({ 'order.id': orderId, 'payment.amount': amount });
    await fraudCheck(amount, cardNumber);
    const paymentId = await chargeCard(amount, cardNumber);
    res.json({ paymentId, orderId, amount, status: 'CAPTURED' });
  });
});

start(app, 3003);
