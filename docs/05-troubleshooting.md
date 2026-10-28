# 5. Troubleshooting

## Quick health check (minikube)

```bash
kubectl -n tracing get pods,svc,endpoints
```

```bash
kubectl -n tracing get events --sort-by=.lastTimestamp | tail -20
```

```bash
helm status jaeger -n tracing
```

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Pods in `ErrImagePull` / `ImagePullBackOff` for `jaeger-demo:1.0` | Image built on the laptop, not inside minikube | `minikube image build -t jaeger-demo:1.0 .` then `kubectl -n tracing rollout restart deployment` |
| Pods `Pending` | Not enough memory/CPU on the node | `kubectl describe pod <pod> -n tracing`; scale other workloads down; `kubectl top node` |
| `OOMKilled` | Limit too low (128Mi app / 384Mi Jaeger) | Raise `resources.limits.memory`, or lower `max_traces` / `MEMORY_MAX_TRACES` for Jaeger |
| App works but **no services in Jaeger** | Wrong OTLP endpoint, or Jaeger not ready | `kubectl -n tracing get configmap otel-config -o yaml`; `kubectl -n tracing logs deploy/order-service \| grep tracing`; the `jaeger` Service must exist in `tracing` |
| Logs show `OTLPExporterError` / `ECONNREFUSED ...:4318` | Jaeger started after the app, or the Service name differs | Install Jaeger with release name `jaeger` in namespace `tracing`, then `kubectl -n tracing rollout restart deployment` |
| Each service shows up as a **separate trace** | Context not propagated | Services must call each other through `fetch()` / `http` (auto-instrumented) and be started with `--require ./src/tracing.js` |
| No `middleware - ...` spans | Express loaded before the SDK | Keep `--require ./src/tracing.js` (see Dockerfile `CMD`) |
| `curl localhost:16686/api/services` returns 404 | Jaeger v2 (Helm chart 4.x) moved the API | Use `/api/v3/services` (v1 all-in-one keeps `/api/services`) |
| Jaeger pod `CrashLoopBackOff` after editing `userconfig` | Invalid collector config | `kubectl -n tracing logs deploy/jaeger --previous`; `helm rollback jaeger -n tracing` |
| `helm upgrade` error: resource exists and can't be imported | `jaeger` Deployment/Service created earlier by `kubectl apply -k k8s/` | `kubectl -n tracing delete deployment,service jaeger`, then re-run the Helm install |
| Port-forward stops working | Pod restarted (port-forward binds to one pod) | Re-run the `kubectl port-forward` command |
| Ingress hosts don't open (macOS) | Docker driver needs a tunnel | Run `minikube tunnel` and keep it open |
| Traces disappear | In-memory storage: Jaeger restarted, or `max_traces` reached | Expected in the lab; use persistent storage for real setups |

## Useful debug commands

See the `traceparent` header that links the services (temporarily add `console.log(req.headers.traceparent)` to a handler, rebuild, then):

```bash
kubectl -n tracing logs deployment/inventory-service -f
```

Call a service directly from inside the cluster:

```bash
kubectl -n tracing run tmp-curl --rm -it --image=curlimages/curl:8.11.1 --restart=Never -- curl -s http://order-service:3001/health
```

Print the OpenTelemetry SDK's own debug logs (very verbose):

```bash
kubectl -n tracing set env deployment/order-service OTEL_LOG_LEVEL=debug
```

```bash
kubectl -n tracing set env deployment/order-service OTEL_LOG_LEVEL-
```
