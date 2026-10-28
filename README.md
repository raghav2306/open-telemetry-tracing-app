# Distributed Tracing Lab: Node.js + OpenTelemetry + Jaeger

A small microservices shop for a hands-on lab. **One HTTP request becomes one trace** that crosses four services,
and Jaeger shows every hop, every Express middleware and every business function in it.

```
                 ┌──────────────┐      ┌───────────────┐      ┌───────────────────┐
  curl ────────► │ api-gateway  │ ───► │ order-service │ ───► │ inventory-service │
                 │   :3000      │      │    :3001      │      │      :3002        │
                 └──────────────┘      └───────┬───────┘      └───────────────────┘
                                               │              ┌───────────────────┐
                                               └────────────► │  payment-service  │
                                                              │      :3003        │
                                                              └───────────────────┘
   every service ──(OTLP/HTTP :4318)──► Jaeger ──► UI http://localhost:16686
```

You can run it three ways:

| Way | Jaeger | Guide |
|---|---|---|
| **docker compose** (quickest) | `jaegertracing/all-in-one` container | [section 3](#3-run-with-docker-compose) |
| **minikube + Helm** (Kubernetes lab) | official Jaeger Helm chart (Jaeger v2) | [section 4](#4-run-on-minikube) and [`docs/`](docs/README.md) |
| **minikube, plain manifests** | `k8s/jaeger/` all-in-one manifest | [section 4.6](#46-alternative-jaeger-without-helm) |

## 1. Concepts in two minutes

- **Trace**: the whole journey of one request. It has one **trace id**.
- **Span**: one timed operation inside the trace (an HTTP call, a middleware, a function). Spans form a tree (parent → child).
- **Context propagation**: when service A calls service B, the OpenTelemetry instrumentation adds a W3C `traceparent`
  header. B reads it and continues the **same** trace.
- **Attributes**: key/value tags on a span (`order.id`, `enduser.id`, `payment.card_last4`).
- **Events**: timestamped messages inside a span (`cache.miss`, `payment.failed`). Jaeger shows them under **Logs**.
- **Status / exceptions**: a span can be marked `ERROR` and carry an `exception` event with the stack trace.

## 2. Project layout

```
jaeger-tracing/
├── src/
│   ├── tracing.js              # OpenTelemetry SDK bootstrap (loaded with node --require)
│   ├── lib/
│   │   ├── traced.js           # withSpan() + traced() wrapper: MANUAL function-level spans
│   │   ├── middleware.js       # requestContext, requireAuth, validate(), errorHandler: span-aware middlewares
│   │   ├── logger.js           # JSON logs with trace_id / span_id
│   │   ├── http-client.js      # fetch() wrapper used for service-to-service calls
│   │   └── create-app.js       # shared Express setup
│   └── services/               # api-gateway, order-service, inventory-service, payment-service
├── Dockerfile                  # ONE image for all services (SERVICE env picks which one runs)
├── docker-compose.yml          # 4 services + Jaeger all-in-one
├── k8s/
│   ├── kustomization.yaml      # app + Jaeger manifest (no Helm)
│   ├── app/                    # namespace, ConfigMap, 4 Deployments + Services
│   ├── jaeger/                 # Jaeger all-in-one manifest (alternative to Helm)
│   └── extras/                 # optional Ingress + in-cluster load-generator Job
├── helm/jaeger-values.yaml     # values for the official Jaeger Helm chart
├── scripts/load.sh             # traffic generator
└── docs/                       # step-by-step minikube + Helm guides
```

## 3. Run with docker compose

```bash
cd /Users/raghav/DevOps/jaeger-tracing
```

```bash
docker compose up --build -d
```

```bash
docker compose ps
```

```bash
docker compose logs -f order-service
```

- App (gateway): http://localhost:3000
- Jaeger UI: http://localhost:16686

Then go to [section 5](#5-send-requests).

Stop / restart / remove:

```bash
docker compose stop
```

```bash
docker compose start
```

```bash
docker compose down
```

After a code change:

```bash
docker compose up --build -d
```

## 4. Run on minikube

Step-by-step explanations are in [`docs/`](docs/README.md). The commands, in order:

### 4.1 Prerequisites

```bash
minikube version
```

```bash
kubectl version --client
```

```bash
helm version
```

```bash
minikube start --driver=docker --cpus=2 --memory=4096
```

(If your cluster already exists, `minikube status` is enough.) The whole lab requests about 350Mi of memory.

### 4.2 Build the app image inside minikube

```bash
cd /Users/raghav/DevOps/jaeger-tracing
```

```bash
minikube image build -t jaeger-demo:1.0 .
```

```bash
minikube image ls | grep jaeger-demo
```

### 4.3 Install Jaeger with Helm

Details: [docs/02-install-jaeger-with-helm.md](docs/02-install-jaeger-with-helm.md)

```bash
helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
```

```bash
helm repo update
```

```bash
helm upgrade --install jaeger jaegertracing/jaeger --version 4.16.1 --namespace tracing --create-namespace -f helm/jaeger-values.yaml
```

```bash
kubectl -n tracing rollout status deployment/jaeger
```

```bash
helm status jaeger -n tracing
```

The release name `jaeger` creates the Service `jaeger` (ports 4317/4318/16686) that the app sends spans to.

### 4.4 Deploy the app

Details: [docs/03-deploy-app-on-minikube.md](docs/03-deploy-app-on-minikube.md)

```bash
kubectl apply -k k8s/app
```

```bash
kubectl -n tracing rollout status deployment/api-gateway
```

```bash
kubectl -n tracing get pods,svc
```

### 4.5 Open the app and Jaeger

Run each in its own terminal and keep them open:

```bash
kubectl -n tracing port-forward svc/api-gateway 3000:3000
```

```bash
kubectl -n tracing port-forward svc/jaeger 16686:16686
```

Same URLs as with compose: app http://localhost:3000, Jaeger http://localhost:16686. Then go to [section 5](#5-send-requests).

Alternatives:

```bash
minikube service api-gateway -n tracing --url
```

```bash
minikube addons enable ingress
```

```bash
kubectl apply -f k8s/extras/ingress.yaml
```

```bash
minikube tunnel
```

With the tunnel running: http://shop.127.0.0.1.nip.io and http://jaeger.127.0.0.1.nip.io.

### 4.6 Alternative: Jaeger without Helm

Instead of 4.3 + 4.4, apply the app and the Jaeger all-in-one manifest together:

```bash
kubectl apply -k k8s/
```

(Don't combine this with the Helm release: both create a Deployment/Service named `jaeger`.)

### 4.7 In-cluster traffic (optional)

```bash
kubectl apply -f k8s/extras/load-generator-job.yaml
```

```bash
kubectl -n tracing logs -f job/load-generator
```

```bash
kubectl -n tracing delete job load-generator
```

### 4.8 Update after a code change

```bash
minikube image build -t jaeger-demo:1.0 .
```

```bash
kubectl -n tracing rollout restart deployment -l app.kubernetes.io/part-of=jaeger-tracing-demo
```

## 5. Send requests

All `/api` routes need `Authorization: Bearer demo-token`.

| Scenario | Expected | What happens |
|---|---|---|
| `happy` | `201`, ~0.2 s | all four services, all green |
| `slow` | `201`, ~1.5 s | cache miss → slow warehouse lookup in inventory-service |
| `error` | `502` | payment processor crashes (500); order-service releases the stock (compensation) |
| `declined` | `402` | card declined, a business error (4xx) |
| `soldout` | `409` | out of stock in inventory-service |
| `invalid` | `400` | rejected by the validation middleware in the gateway |
| no token | `401` | rejected by the auth middleware in the gateway |

```bash
curl -i -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/happy
```

```bash
curl -i -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/slow
```

```bash
curl -i -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/error
```

```bash
curl -i -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/declined
```

```bash
curl -i -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/soldout
```

```bash
curl -i -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/invalid
```

```bash
curl -i localhost:3000/api/demo/happy
```

Place an order with your own body:

```bash
curl -i -X POST localhost:3000/api/orders -H 'Authorization: Bearer demo-token' -H 'content-type: application/json' -d '{"sku":"PEN-7","qty":3,"cardNumber":"4111111111111111"}'
```

Products: `BOOK-101`, `PEN-7`, `RARE-900` (slow), `SOLDOUT-1`. Test cards: `4111111111111111` OK,
`4000000000000002` declined, `4000000000000119` processor error.

Every response has an `x-trace-id` header (error bodies also contain `traceId`). Paste it into Jaeger's top search box:

```bash
curl -s -D - -o /dev/null -H 'Authorization: Bearer demo-token' localhost:3000/api/demo/error | grep -i x-trace-id
```

Generate a mix of traffic (default 30 requests):

```bash
./scripts/load.sh 50
```

Check from the command line that the services reached Jaeger:

```bash
curl -s localhost:16686/api/services
```

```bash
curl -s localhost:16686/api/v3/services
```

(The first is for Jaeger v1, used by compose and `k8s/jaeger/`; the second is for Jaeger v2, used by the Helm chart.)

## 6. What to look at in Jaeger

The full guided tour with exercises is in [docs/04-lab-walkthrough.md](docs/04-lab-walkthrough.md). In short:

1. **Search**: Service `api-gateway` → **Find Traces**. Slow traces sit high in the scatter plot, failed ones are red.
   Filter with Tags such as `error=true`, `demo.scenario=slow`, `http.response.status_code=502`, or Min Duration `1s`.
2. **Trace waterfall** (happy path, ~34 spans across 4 services):

```
api-gateway      GET /api/demo/:scenario                ← HTTP server span (auto)
  api-gateway      middleware - requestContext            ← Express middleware span (auto)
  api-gateway      middleware - requireAuth               ← Express middleware span (auto)
    api-gateway      auth.verifyToken                     ← MANUAL span inside the middleware
  api-gateway      middleware - validateOrder
    api-gateway      validation.validateOrder             ← MANUAL span
  api-gateway      request handler - /api/demo/:scenario
    api-gateway      gateway.forwardOrder                 ← FUNCTION span (traced() wrapper)
      api-gateway      POST                               ← HTTP client span (auto, fetch)
        order-service    POST /orders                     ← next SERVICE, same trace
          order-service    order.workflow
            order-service    order.calculateTotal         ← function span
            ...              inventory-service: inventory.checkStock, inventory.reserve
            ...              payment-service:   payment.fraudCheck, payment.chargeCard
            order-service    order.save                   ← function span (simulated DB)
```

3. **Middleware spans vs function spans**: `middleware - …` / `request handler - …` come from auto-instrumentation;
   `auth.verifyToken`, `order.calculateTotal`, `payment.chargeCard` come from our code (`src/lib/traced.js`).
4. **Span details**: Tags (`order.id`, `enduser.id`, `payment.card_last4`), Logs/events (`cache.miss`, `order.priced`), Process (`service.name`, `deployment.environment`).
5. **Slow path**: the time is in `inventory.warehouseLookup` (with a `cache.miss` event).
6. **Error path**: red spans; the `exception` event on `payment.chargeCard` has the stack trace; `order.compensate.releaseStock` runs after the failure.
7. **4xx vs 5xx**: for `declined`, only the function span is red. By OTel conventions a 4xx doesn't mark the server span as an error.
8. **Service map**: **System Architecture** (Dependencies) shows `api-gateway → order-service → inventory/payment`.
9. **Logs ↔ traces**: every log line has a `trace_id`:

```bash
docker compose logs order-service | tail -5
```

```bash
kubectl -n tracing logs deployment/order-service --tail=5
```

## 7. How the code wires tracing

```js
// 1) Start the SDK before anything else (Dockerfile CMD / package.json scripts):
//    node --require ./src/tracing.js src/services/order-service.js

// 2) Wrap a function so every call is a span (src/lib/traced.js)
const saveOrder = traced('order.save', async (order) => { ... },
                         () => ({ 'db.system': 'in-memory', 'db.operation': 'INSERT' }));

// 3) Ad-hoc span around a block, with attributes and events
await withSpan('order.workflow', { 'order.id': id }, async (span) => {
  span.addEvent('order.priced', { total });
  span.setAttribute('order.total', total);
});   // exceptions are recorded + status ERROR automatically

// 4) Enrich the current request's server span from a middleware
req.otelServerSpan.setAttribute('enduser.id', userId);
```

Environment variables used by every service:

| Variable | Example | Purpose |
|---|---|---|
| `SERVICE` | `order-service` | which file in `src/services/` the container runs |
| `OTEL_SERVICE_NAME` | `order-service` | service name in Jaeger |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://jaeger:4318` | where spans are sent (OTLP/HTTP) |
| `PORT` | `3001` | listen port |
| `ORDER_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `PAYMENT_SERVICE_URL` | `http://order-service:3001` | downstream services |
| `DEPLOY_ENV` | `minikube` | becomes the `deployment.environment` resource attribute |

## 8. Run without containers (optional)

Jaeger still runs in Docker:

```bash
docker compose up -d jaeger
```

```bash
npm install
```

Then one command per terminal (each sets `OTEL_SERVICE_NAME` and `--require ./src/tracing.js`):

```bash
npm run inventory
```

```bash
npm run payment
```

```bash
npm run order
```

```bash
npm run gateway
```

## 9. Clean up

docker compose:

```bash
docker compose down
```

minikube (app, then Jaeger, then the namespace):

```bash
kubectl delete -k k8s/app
```

```bash
helm uninstall jaeger -n tracing
```

```bash
kubectl delete namespace tracing
```

Remove the image from minikube:

```bash
minikube image rm jaeger-demo:1.0
```

Jaeger keeps traces **in memory only** in every setup here, so restarting it clears all traces.

## 10. More docs

- [docs/01-minikube-setup.md](docs/01-minikube-setup.md): tools, cluster, building the image
- [docs/02-install-jaeger-with-helm.md](docs/02-install-jaeger-with-helm.md): Helm chart, values, verify, ingress, upgrade/rollback
- [docs/03-deploy-app-on-minikube.md](docs/03-deploy-app-on-minikube.md): the manifests explained, access, scaling and failure experiments
- [docs/04-lab-walkthrough.md](docs/04-lab-walkthrough.md): Jaeger UI tour and lab exercises
- [docs/05-troubleshooting.md](docs/05-troubleshooting.md)
