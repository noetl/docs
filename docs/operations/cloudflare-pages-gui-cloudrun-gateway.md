---
title: Cloudflare GUI and Cloud Run Gateway
description: Deploy the NoETL GUI to Cloudflare Pages and move Gateway from a public GKE LoadBalancer to Cloud Run.
sidebar_position: 6
---

# Cloudflare GUI and Cloud Run Gateway

This runbook moves the public edge out of GKE:

- `https://mestumre.dev` serves the static NoETL GUI from Cloudflare Pages.
- `https://gateway.mestumre.dev` serves NoETL Gateway from Cloud Run.
- GKE keeps NoETL server, workers, NATS, and PgBouncer private.
- The GKE Gateway LoadBalancer is removed after Cloud Run is verified.

The immediate symptom this fixes is a Cloudflare `522` on `mestumre.dev`
after the in-cluster GUI has been removed.

## Cloudflare API Token

For local `wrangler pages deploy`, create a Cloudflare **API token**, not a
Global API Key.

Minimum token for GUI deployment:

| Scope | Permission | Access |
|---|---|---|
| Account | Cloudflare Pages | Edit |

Recommended token if the same shell will also update DNS:

| Scope | Permission | Access |
|---|---|---|
| Account | Cloudflare Pages | Edit |
| Zone | DNS | Edit |

Limit the token resources:

- Account resources: include only the account that owns the Pages project.
- Zone resources: include only `mestumre.dev`.

Export it only in the shell that runs the deployment:

```bash
export CLOUDFLARE_API_TOKEN=...
```

Do not commit this token to any repository.

References:

- Cloudflare Pages Direct Upload: https://developers.cloudflare.com/pages/get-started/direct-upload/
- Cloudflare Pages API notes: https://developers.cloudflare.com/pages/configuration/api/
- Cloudflare API token permissions: https://developers.cloudflare.com/fundamentals/api/reference/permissions/

## Variables

```bash
export PROJECT_ID=noetl-demo-19700101
export REGION=us-central1
export CLUSTER=noetl-cluster
export DOMAIN=mestumre.dev
export GATEWAY_DOMAIN=gateway.mestumre.dev
export CONNECTOR=noetl-cloudrun-connector
export CONNECTOR_RANGE=10.8.0.0/28
```

## Deploy GUI to Cloudflare Pages

Build the GUI as a gateway-mode static app:

```bash
cd /Volumes/X10/projects/noetl/ai-meta/repos/gui

npm ci
VITE_API_MODE=gateway \
VITE_API_BASE_URL=https://gateway.mestumre.dev \
VITE_GATEWAY_URL=https://gateway.mestumre.dev \
VITE_ALLOW_SKIP_AUTH=false \
npm run build
```

Deploy the `dist` directory:

```bash
npx wrangler pages deploy dist --project-name noetl-gui --branch main
```

In Cloudflare Pages, attach the custom domain:

```text
mestumre.dev -> noetl-gui
```

In Auth0, allow the production GUI origin:

```text
Allowed Callback URLs: https://mestumre.dev/login
Allowed Logout URLs:   https://mestumre.dev
Allowed Web Origins:   https://mestumre.dev
```

After the Pages custom domain is active, `https://mestumre.dev` should no
longer point to a GKE GUI LoadBalancer. If it still returns `522`, check the
Cloudflare DNS record for the apex domain and remove the stale origin target.

## Create Private GKE Origins for Cloud Run

Cloud Run cannot call Kubernetes `*.svc.cluster.local` DNS names directly.
Expose NoETL and NATS through internal-only GKE LoadBalancers.

```bash
gcloud container clusters get-credentials "$CLUSTER" \
  --region "$REGION" \
  --project "$PROJECT_ID"

cat <<'YAML' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: noetl-internal
  namespace: noetl
  annotations:
    networking.gke.io/load-balancer-type: "Internal"
spec:
  type: LoadBalancer
  selector:
    app: noetl-server
  ports:
    - name: http
      port: 8082
      targetPort: 8082
---
apiVersion: v1
kind: Service
metadata:
  name: nats-internal
  namespace: nats
  annotations:
    networking.gke.io/load-balancer-type: "Internal"
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: nats
    app.kubernetes.io/instance: nats
    app.kubernetes.io/component: nats
  ports:
    - name: nats
      port: 4222
      targetPort: 4222
YAML

kubectl -n noetl wait --for=jsonpath='{.status.loadBalancer.ingress[0].ip}' svc/noetl-internal --timeout=180s
kubectl -n nats wait --for=jsonpath='{.status.loadBalancer.ingress[0].ip}' svc/nats-internal --timeout=180s

export NOETL_INTERNAL_IP=$(kubectl -n noetl get svc noetl-internal -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export NATS_INTERNAL_IP=$(kubectl -n nats get svc nats-internal -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
```

## Create the Cloud Run VPC Connector

```bash
gcloud services enable run.googleapis.com vpcaccess.googleapis.com \
  --project "$PROJECT_ID"

gcloud compute networks vpc-access connectors create "$CONNECTOR" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --network default \
  --range "$CONNECTOR_RANGE" \
  --min-instances 2 \
  --max-instances 3
```

## Deploy Gateway to Cloud Run

```bash
cat >/tmp/noetl-gateway-cloudrun.env.yaml <<EOF
ROUTER_PORT: "8090"
NOETL_BASE_URL: "http://${NOETL_INTERNAL_IP}:8082"
NATS_URL: "nats://noetl:noetl@${NATS_INTERNAL_IP}:4222"
CORS_ALLOWED_ORIGINS: "https://mestumre.dev,https://gateway.mestumre.dev,http://localhost:3001"
GATEWAY_PUBLIC_URL: "https://gateway.mestumre.dev"
AUTH_PLAYBOOKS_TIMEOUT_SECS: "120"
AUTH_PLAYBOOK_TIMEOUT_SECS: "120"
NOETL_TIMEOUT_SECS: "120"
NATS_REQUEST_TTL_SECS: "300"
EOF

gcloud run deploy noetl-gateway \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image ghcr.io/noetl/gateway:v2.10.0 \
  --port 8090 \
  --allow-unauthenticated \
  --vpc-connector "$CONNECTOR" \
  --vpc-egress private-ranges-only \
  --env-vars-file /tmp/noetl-gateway-cloudrun.env.yaml

export CLOUDRUN_URL=$(gcloud run services describe noetl-gateway \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format='value(status.url)')

curl -fsS "$CLOUDRUN_URL/health"
```

## Map Gateway Domain

Create the Cloud Run domain mapping:

```bash
gcloud beta run domain-mappings create \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --service noetl-gateway \
  --domain "$GATEWAY_DOMAIN"
```

In Cloudflare DNS, replace the old `gateway` A record with the target Google
returns. For Cloud Run domain mappings this is commonly:

```text
Type: CNAME
Name: gateway
Target: ghs.googlehosted.com
Proxy status: Proxied
```

Verify:

```bash
curl -fsS https://gateway.mestumre.dev/health
curl -i -X OPTIONS https://gateway.mestumre.dev/noetl/api/health \
  -H 'Origin: https://mestumre.dev' \
  -H 'Access-Control-Request-Method: GET'
```

The preflight response must include:

```text
access-control-allow-origin: https://mestumre.dev
```

## Remove the Public GKE Gateway

Only do this after Cloud Run Gateway is healthy.

```bash
helm uninstall noetl-gateway -n gateway --ignore-not-found
kubectl delete namespace gateway --ignore-not-found=true

kubectl get svc -A | awk 'NR==1 || $5 != "<none>" {print}'
```

Expected result: no public GKE services remain.

Optionally release the old static IP:

```bash
gcloud compute addresses delete gateway-static-ip \
  --project "$PROJECT_ID" \
  --region "$REGION"
```

## Final Smoke Test

```bash
curl -I https://mestumre.dev
curl -fsS https://gateway.mestumre.dev/health
kubectl get svc -A | awk 'NR==1 || $5 != "<none>" {print}'
```

Expected:

- `mestumre.dev` serves the Cloudflare Pages GUI.
- `gateway.mestumre.dev/health` returns `ok`.
- GKE has no external services.
