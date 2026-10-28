# 3. Deploy the demo app on minikube

Goal: the four Node.js services running in the `tracing` namespace and sending traces to Jaeger.

Prerequisites: [01 – minikube setup](01-minikube-setup.md) (image `jaeger-demo:1.0` built inside minikube) and
Jaeger installed, either with [Helm (02)](02-install-jaeger-with-helm.md) or with the plain manifest (3.2, option B).

## 3.1 The manifests

```
k8s/
├── kustomization.yaml          # app + Jaeger manifest (no Helm)      -> kubectl apply -k k8s/
├── app/                        # the demo application ONLY             -> kubectl apply -k k8s/app
│   ├── namespace.yaml          #   namespace "tracing"
│   ├── configmap.yaml          #   otel-config: OTLP endpoint + service URLs (shared via envFrom)
│   ├── api-gateway.yaml        #   Deployment + Service (NodePort 30080)
│   ├── order-service.yaml      #   Deployment + Service (ClusterIP)
│   ├── inventory-service.yaml  #   Deployment + Service (ClusterIP)
│   ├── payment-service.yaml    #   Deployment + Service (ClusterIP)
│   └── kustomization.yaml
├── jaeger/                     # Jaeger all-in-one WITHOUT Helm         -> kubectl apply -k k8s/jaeger
│   ├── namespace.yaml
│   ├── jaeger-all-in-one.yaml  #   Deployment + Service "jaeger" (same name/ports as the Helm release)
│   └── kustomization.yaml
└── extras/                     # optional
    ├── ingress.yaml            #   shop.127.0.0.1.nip.io + jaeger.127.0.0.1.nip.io
    └── load-generator-job.yaml #   in-cluster traffic generator (curl)
helm/
└── jaeger-values.yaml          # values for the official Jaeger Helm chart
```

What to point out in the app manifests:

- **One image, four Deployments.** `SERVICE` picks which file in `src/services/` runs; `OTEL_SERVICE_NAME` is the name shown in Jaeger.
- **`envFrom: configMapRef: otel-config`.** `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger.tracing.svc.cluster.local:4318` and the downstream URLs use Kubernetes DNS (`<service>.<namespace>.svc.cluster.local`).
- **Probes on `/health`.** That path is excluded from tracing in `src/tracing.js`, otherwise kubelet probes would flood Jaeger.
- **`terminationGracePeriodSeconds: 10`.** On `SIGTERM` the OTel SDK flushes buffered spans before exiting.
- **Small resources** (20m CPU / 48Mi request, 128Mi limit), non-root user, read-only root filesystem.

Preview what will be applied (no cluster changes):

```bash
kubectl kustomize k8s/app
```

```bash
kubectl apply -k k8s/app --dry-run=client
```

## 3.2 Deploy

### Option A: Jaeger from Helm (recommended) + app manifests

```bash
helm upgrade --install jaeger jaegertracing/jaeger --version 4.16.1 --namespace tracing --create-namespace -f helm/jaeger-values.yaml
```

```bash
kubectl apply -k k8s/app
```

### Option B: everything from plain manifests (no Helm)

```bash
kubectl apply -k k8s/
```

> Don't mix the two: options A and B both create a Deployment/Service called `jaeger`.
> To switch from B to A, run `kubectl -n tracing delete deployment,service jaeger` first.

### Wait until everything is ready

```bash
kubectl -n tracing rollout status deployment/api-gateway
```

```bash
kubectl -n tracing get pods,svc -o wide
```

```bash
kubectl -n tracing logs deployment/order-service --tail=5
```

Every service prints `[tracing] OpenTelemetry started for "<name>" -> http://jaeger.tracing.svc.cluster.local:4318`.

## 3.3 Reach the app and the Jaeger UI

Port-forward (works everywhere; keep both terminals open):

```bash
kubectl -n tracing port-forward svc/api-gateway 3000:3000
```

```bash
kubectl -n tracing port-forward svc/jaeger 16686:16686
```

- App: http://localhost:3000
- Jaeger UI: http://localhost:16686

Alternative for the gateway: the NodePort service (on macOS with the docker driver this opens a tunnel and prints a URL; keep it running):

```bash
minikube service api-gateway -n tracing --url
```

Alternative for both: Ingress (see `k8s/extras/ingress.yaml`):

```bash
minikube addons enable ingress
```

```bash
kubectl apply -f k8s/extras/ingress.yaml
```

```bash
minikube tunnel
```

Then use http://shop.127.0.0.1.nip.io and http://jaeger.127.0.0.1.nip.io.

## 3.4 Send traffic

From your laptop (through the port-forward):

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
./scripts/load.sh 50
```

Or from inside the cluster with the load-generator Job (no port-forward needed for the app):

```bash
kubectl apply -f k8s/extras/load-generator-job.yaml
```

```bash
kubectl -n tracing logs -f job/load-generator
```

```bash
kubectl -n tracing delete job load-generator
```

Check that spans arrived (with the Jaeger port-forward running):

```bash
curl -s localhost:16686/api/v3/services
```

(For the v1 all-in-one image from option B the path is `/api/services`.)

## 3.5 Kubernetes-specific things to look at in Jaeger

- Expand a span → **Process**: `deployment.environment=minikube` (from the ConfigMap). Add host/pod details by
  setting `OTEL_RESOURCE_ATTRIBUTES=k8s.pod.name=$(K8S_POD_NAME)` in a Deployment, then compare.
- Scale a service and watch requests spread across pods:

```bash
kubectl -n tracing scale deployment/payment-service --replicas=2
```

- Break a dependency and look at the trace (gateway returns 503/502, and the compensation call still runs):

```bash
kubectl -n tracing scale deployment/payment-service --replicas=0
```

```bash
kubectl -n tracing scale deployment/payment-service --replicas=1
```

## 3.6 Update and clean up

After a code change:

```bash
minikube image build -t jaeger-demo:1.0 .
```

```bash
kubectl -n tracing rollout restart deployment -l app.kubernetes.io/part-of=jaeger-tracing-demo
```

Remove the app only:

```bash
kubectl delete -k k8s/app
```

Remove Jaeger (Helm):

```bash
helm uninstall jaeger -n tracing
```

Remove everything (option B, or after the Helm uninstall):

```bash
kubectl delete namespace tracing
```

Next: [04 – Lab walkthrough](04-lab-walkthrough.md)
