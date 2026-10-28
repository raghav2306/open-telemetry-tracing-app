# 2. Install Jaeger on minikube with Helm

Goal: Jaeger running in the `tracing` namespace, installed from the **official Jaeger Helm chart**,
receiving spans over OTLP and serving its UI on port 16686.

## 2.1 What gets installed

The chart `jaegertracing/jaeger` **4.x** installs **Jaeger v2** (chart 4.16.1 → Jaeger 2.22.0).
Jaeger v2 is built on the OpenTelemetry Collector, so a single binary does everything:

```
 Node.js services ──OTLP/HTTP :4318──►┌────────────────── jaeger pod ──────────────────┐
 (or OTLP/gRPC :4317)                 │ receivers: otlp ─► processors: batch ─►         │
                                      │ exporters: jaeger_storage_exporter ─► memstore  │
 browser ──────────── :16686 ────────►│ extensions: jaeger_query (UI + API)             │
 kubelet probes ───── :13133 ────────►│             healthcheckv2 (/status)             │
                                      └─────────────────────────────────────────────────┘
```

With release name `jaeger` the chart creates:

| Object | Name | Notes |
|---|---|---|
| Deployment | `jaeger` | 1 replica, image `jaegertracing/jaeger:2.22.0` |
| Service (ClusterIP) | `jaeger` | ports 4317 (OTLP gRPC), 4318 (OTLP HTTP), 16686 (UI), plus legacy ports |
| ConfigMap | `user-config` | rendered from `userconfig:` in our values file |
| ServiceAccount | `jaeger` | |

The app's ConfigMap (`k8s/app/configmap.yaml`) sends spans to `http://jaeger.tracing.svc.cluster.local:4318`,
so **keep the release name `jaeger` and namespace `tracing`** (or update that ConfigMap).

## 2.2 Add the Helm repository

```bash
helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
```

```bash
helm repo update
```

```bash
helm search repo jaegertracing/jaeger --versions | head
```

## 2.3 Look at the chart before installing (optional, recommended for the lab)

Default values of the chart:

```bash
helm show values jaegertracing/jaeger --version 4.16.1 | less
```

Our overrides are in [`helm/jaeger-values.yaml`](../helm/jaeger-values.yaml):

- `jaeger.resources`: small requests/limits for minikube (the chart sets none by default)
- `userconfig`: the Jaeger v2 (OTel Collector style) config: OTLP receiver → batch → **in-memory** storage capped at **5000 traces**, the query UI, and the health check used by the probes
- `jaeger.ingress`: disabled by default; see 2.7

Render the manifests locally without touching the cluster:

```bash
helm template jaeger jaegertracing/jaeger --version 4.16.1 -n tracing -f helm/jaeger-values.yaml | less
```

## 2.4 Install

```bash
helm upgrade --install jaeger jaegertracing/jaeger --version 4.16.1 --namespace tracing --create-namespace -f helm/jaeger-values.yaml
```

`upgrade --install` installs the first time and upgrades afterwards, so you can re-run it after editing the values file.

Wait for it:

```bash
kubectl -n tracing rollout status deployment/jaeger
```

```bash
kubectl -n tracing get pods,svc -l app.kubernetes.io/instance=jaeger
```

## 2.5 Verify Jaeger

Release status and the values in use:

```bash
helm list -n tracing
```

```bash
helm status jaeger -n tracing
```

```bash
helm get values jaeger -n tracing
```

The config Jaeger actually loaded:

```bash
kubectl -n tracing get configmap user-config -o yaml
```

Logs (look for `Query server started` and `Everything is ready`):

```bash
kubectl -n tracing logs deployment/jaeger --tail=30
```

Open the UI (keep this terminal open):

```bash
kubectl -n tracing port-forward svc/jaeger 16686:16686
```

Browse to http://localhost:16686. The **Service** dropdown may already list `jaeger` (Jaeger traces itself);
our services appear after the app sends its first request.

Query API check from a second terminal. Jaeger v2 serves its API under `/api/v3`:

```bash
curl -s localhost:16686/api/v3/services
```

## 2.6 Send a test span by hand (optional)

This shows that Jaeger only needs OTLP: no SDK required. Port-forward the OTLP HTTP port:

```bash
kubectl -n tracing port-forward svc/jaeger 4318:4318
```

```bash
curl -s -X POST localhost:4318/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"curl-test"}}]},"scopeSpans":[{"spans":[{"traceId":"0102030405060708090a0b0c0d0e0f10","spanId":"0102030405060708","name":"hello-jaeger","kind":2,"startTimeUnixNano":"1767225600000000000","endTimeUnixNano":"1767225600500000000"}]}]}]}'
```

Then search for service `curl-test` in the UI (set **Lookback** to a wide range, since the timestamp is fixed),
or open the trace directly: http://localhost:16686/trace/0102030405060708090a0b0c0d0e0f10

## 2.7 Optional: expose the UI with Ingress instead of port-forward

```bash
minikube addons enable ingress
```

```bash
helm upgrade --install jaeger jaegertracing/jaeger --version 4.16.1 -n tracing -f helm/jaeger-values.yaml --set jaeger.ingress.enabled=true
```

On macOS/Windows with the docker driver, ingress is reachable only through a tunnel (keep it running; it may ask for your password):

```bash
minikube tunnel
```

Open http://jaeger.127.0.0.1.nip.io (`nip.io` resolves to 127.0.0.1, so no `/etc/hosts` edit is needed).

## 2.8 Upgrade, roll back, uninstall

Change a value (e.g. keep more traces) and upgrade:

```bash
helm upgrade jaeger jaegertracing/jaeger --version 4.16.1 -n tracing -f helm/jaeger-values.yaml --set userconfig.extensions.jaeger_storage.backends.memstore.memory.max_traces=10000
```

```bash
helm history jaeger -n tracing
```

```bash
helm rollback jaeger 1 -n tracing
```

Remove Jaeger (all stored traces are lost, since they are only in memory):

```bash
helm uninstall jaeger -n tracing
```

## 2.9 Going further (discussion points)

- **Storage:** memory is for labs only. For real use, point `jaeger_storage` at Elasticsearch/OpenSearch, Cassandra or Badger (with a PVC). The chart's `values.yaml` has commented Elasticsearch examples; since this cluster already runs an EFK stack, Elasticsearch is a natural choice.
- **Sampling:** the Node.js SDK samples 100% by default. In production set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.1` on the services.
- **Jaeger v1 vs v2:** `docker-compose.yml` and `k8s/jaeger/` use the v1 `all-in-one` image (env-var config, API under `/api`); Helm chart 4.x uses v2 (collector-style YAML config, API under `/api/v3`). The UI and the OTLP ports are the same, so the app does not care which one you run.

Next: [03 – Deploy the demo app](03-deploy-app-on-minikube.md)
