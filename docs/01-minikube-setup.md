# 1. Prepare minikube for the lab

Goal: a running minikube cluster, the tools you need, and the demo app's image loaded into minikube.

## 1.1 Tools

| Tool | Check | Install (macOS, Homebrew) |
|---|---|---|
| Docker Desktop | `docker info` | `brew install --cask docker` |
| minikube | `minikube version` | `brew install minikube` |
| kubectl | `kubectl version --client` | `brew install kubectl` |
| Helm 3 or 4 | `helm version` | `brew install helm` |

```bash
docker info --format '{{.ServerVersion}}'
```

```bash
minikube version
```

```bash
kubectl version --client
```

```bash
helm version
```

## 1.2 Start minikube

If you already have a cluster (e.g. with the EFK stack), just make sure it's running:

```bash
minikube status
```

Otherwise create one. 4 GB / 2 CPUs is enough for this lab (the whole demo needs about 400 MB):

```bash
minikube start --driver=docker --cpus=2 --memory=4096
```

```bash
kubectl get nodes
```

How much room is left? (Needs the metrics-server addon.)

```bash
minikube addons enable metrics-server
```

```bash
kubectl top node
```

Memory the lab adds (requests / limits):

| Component | Request | Limit |
|---|---|---|
| Jaeger (Helm or manifest) | 128Mi | 384Mi |
| 4 Node.js services | 4 × 48Mi | 4 × 128Mi |
| load-generator Job (optional) | 16Mi | 32Mi |

If the node is short on memory, scale other workloads down first, for example:

```bash
kubectl -n logging scale deployment --all --replicas=0
```

## 1.3 Build the app image inside minikube

All four services use one image, `jaeger-demo:1.0`. The manifests use `imagePullPolicy: IfNotPresent`,
so the image must exist **inside minikube's Docker**, not only on your laptop.

From the project root:

```bash
cd /Users/raghav/DevOps/jaeger-tracing
```

```bash
minikube image build -t jaeger-demo:1.0 .
```

```bash
minikube image ls | grep jaeger-demo
```

Alternative: point your Docker CLI at minikube's Docker daemon and build normally:

```bash
eval $(minikube docker-env)
```

```bash
docker build -t jaeger-demo:1.0 .
```

```bash
eval $(minikube docker-env --unset)
```

> After changing the code, rebuild with the same command, then restart the pods:
> `kubectl -n tracing rollout restart deployment`

## 1.4 Create the namespace

Everything in this lab lives in the `tracing` namespace:

```bash
kubectl create namespace tracing
```

(`kubectl apply -k k8s/app` and `helm install --create-namespace` also create it, so "AlreadyExists" errors here are harmless.)

Next: [02 – Install Jaeger with Helm](02-install-jaeger-with-helm.md)
