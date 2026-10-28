# 4. Lab walkthrough: reading traces in Jaeger

Works the same for docker compose and minikube. You need:
- the app on http://localhost:3000 (compose, or `kubectl -n tracing port-forward svc/api-gateway 3000:3000`)
- Jaeger UI on http://localhost:16686 (compose, or `kubectl -n tracing port-forward svc/jaeger 16686:16686`)

## Warm-up: generate traces

```bash
for s in happy slow error declined soldout invalid; do curl -s -o /dev/null -w "$s -> %{http_code}\n" -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/$s; done
```

```bash
curl -s -o /dev/null -w "no token -> %{http_code}\n" localhost:3000/api/demo/happy
```

```bash
./scripts/load.sh 50
```

Every response carries an `x-trace-id` header. Print it and paste it in Jaeger's top search box:

```bash
curl -s -D - -o /dev/null -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/error | grep -i x-trace-id
```

> Menu names below are from the Jaeger UI; the v1 (compose / plain manifest) and v2 (Helm) UIs are almost identical.
> If a menu is named slightly differently in your version (e.g. **System Architecture** vs **Dependencies**), use the closest one.

## Exploring the traces

### 1. Search page
1. **Service** dropdown → `api-gateway` → **Find Traces**. All four services appear in the dropdown because they all export spans.
2. The scatter plot at the top shows duration per trace: the **slow** requests sit high up (~1.5 s), and **red dots** are traces with errors.
3. Filter by tag: put `error=true` in **Tags** to list only failed traces, or `demo.scenario=slow`, `enduser.id=student-42`, `http.response.status_code=502`.
4. Use **Min Duration** = `1s` to find the slow ones.

### 2. Trace waterfall (click a happy-path trace)
You'll see about 34 spans across 4 services, nested like this:

```
api-gateway      GET /api/demo/:scenario                ← HTTP server span (auto)
  api-gateway      middleware - requestContext            ← Express middleware span (auto)
  api-gateway      middleware - requireAuth               ← Express middleware span (auto)
    api-gateway      auth.verifyToken                     ← MANUAL span created inside the middleware
  api-gateway      middleware - validateOrder
    api-gateway      validation.validateOrder             ← MANUAL span
  api-gateway      request handler - /api/demo/:scenario
    api-gateway      gateway.forwardOrder                 ← FUNCTION span (traced() wrapper)
      api-gateway      POST                               ← HTTP client span (auto, fetch)
        order-service    POST /orders                     ← next SERVICE, same trace!
          order-service    middleware - validateOrderPayload
          order-service    request handler - /orders
            order-service    order.workflow               ← parent span for the business workflow
              order-service    order.calculateTotal       ← function span
              order-service    POST → inventory-service   POST /inventory/reserve
                                   inventory.checkStock (event: cache.hit), inventory.reserve
              order-service    POST → payment-service     POST /payments/charge
                                   payment.fraudCheck, payment.chargeCard
              order-service    order.save                 ← function span (simulated DB)
```

Points to discuss:
- **Middleware spans vs function spans.** `middleware - …` and `request handler - …` spans are made
  automatically by the Express instrumentation (that's why the middlewares have real function names).
  Spans like `auth.verifyToken`, `order.calculateTotal`, `payment.chargeCard` are made by *our code*
  (`withSpan()` / `traced()` in `src/lib/traced.js`). Auto-instrumentation shows the *edges*; manual spans show the *business logic*.
- **Client span → server span.** Each `POST` client span in one service has the next service's `POST /…` server span as its child. The gap between them is network time.
- **Sequential calls.** Inventory finishes before payment starts: the waterfall makes it obvious that the two calls could be done in parallel.
- **Click a span** to open it:
  - **Tags**: `order.id`, `enduser.id`, `app.request_id`, `payment.card_last4` (never the full card number!), `inventory.cache_hit`, `http.route`, `http.response.status_code`…
  - **Logs** (span events): `request.received`, `order.priced`, `stock.reserved`, `payment.captured`, `cache.hit`…
  - **Process**: `service.name`, `service.version`, `deployment.environment`, host and runtime info (resource attributes).

### 3. Slow path (`/api/demo/slow`)
Open a ~1.5 s trace. Almost all the time sits in **`inventory.warehouseLookup`**, under
`inventory.checkStock`, which has a **`cache.miss`** event. This is the main use of tracing: finding *where* the time goes
without reading any logs. Try **Trace Timeline → Trace Statistics** (top right dropdown) to see time per operation.

### 4. Error path (`/api/demo/error`)
- Red `!` icons mark the failing spans: `payment.chargeCard` → `POST /payments/charge` → … → the gateway root span.
- Open `payment.chargeCard` → **Logs** → `exception` event with `exception.type = ProcessorError`, the message and the full **stack trace**.
- In `order.workflow` you'll see the events `payment.failed` and then an extra span
  **`order.compensate.releaseStock`** → `POST /inventory/release`: the saga compensation that undoes the stock reservation.
- The gateway answers **502** (a dependency failed), and the response body contains the `traceId`.

### 5. 4xx vs 5xx (`declined`, `soldout`, `invalid`, no token)
Compare with the error path: for `declined` (402) the **function span** `payment.chargeCard` is red (it threw),
but the **HTTP server spans are not marked as errors**, because by the OpenTelemetry conventions a 4xx is the client's fault, not a server failure.
They get a `client.error` event and `app.error=true` tag instead (see `errorHandler` in `src/lib/middleware.js`).
`invalid` and the no-token request never leave the gateway: the trace has a single service.
(The no-token trace is named `GET /api` because the request was rejected by `requireAuth`, mounted on `/api`, before any route matched.)

### 6. Service map
- **System Architecture** (top menu) → **DAG**: `api-gateway → order-service → inventory-service / payment-service`,
  with call counts. It's built from the parent/child links between spans, not from any config.
- From a trace, the dropdown at top right → **Trace Graph** shows the same map for that single request.
- **Deep Dependency Graph** (button on the search page) lets you focus on one service and its upstream/downstream calls.

### 7. Compare traces
On the search page tick a happy and a slow trace → **Compare**. Spans that are only in one trace or differ show up in color.

### 8. Logs ↔ traces
```bash
docker compose logs order-service | tail -5
```

```bash
kubectl -n tracing logs deployment/order-service --tail=5
```
Every log line has `trace_id` and `span_id`. Copy a `trace_id` into Jaeger's search box to open the exact trace for that log line.
(If you ship these logs to Elasticsearch/Kibana with EFK, you can search logs by `trace_id` too.)

## Lab exercises
1. Add a new traced function `order.applyCoupon` in `order-service.js` with `traced()`, add an attribute `coupon.code` and an event, rebuild (`docker compose up --build -d`, or on minikube `minikube image build -t jaeger-demo:1.0 .` + `kubectl -n tracing rollout restart deployment/order-service`) and find it in the waterfall.
2. Make the inventory and payment calls run in parallel (`Promise.all`) and compare the before/after waterfalls.
3. Fix the slow path: cache the warehouse result in `checkStock` and confirm `cache.hit` on the second request.
4. Stop `payment-service` (`docker compose stop payment-service`, or `kubectl -n tracing scale deployment/payment-service --replicas=0`) and send a happy request: what do the spans and status codes show? (Hint: `503 Cannot reach …`, then the compensation still runs.)
5. Add `console.log(req.headers.traceparent)` in a downstream service and decode the header: `version-traceid-parentspanid-flags`.

Next: [05 – Troubleshooting](05-troubleshooting.md)
