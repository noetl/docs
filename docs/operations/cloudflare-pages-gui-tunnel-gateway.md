---
title: Cloudflare GUI and GKE Tunnel Gateway
description: Deploy the NoETL GUI to Cloudflare Pages and expose the private GKE Gateway through Cloudflare Tunnel.
sidebar_position: 6
---

# Cloudflare GUI and GKE Tunnel Gateway

This runbook moves the public edge to Cloudflare while keeping the NoETL
runtime private inside GKE:

- `https://mestumre.dev` serves the static NoETL GUI from Cloudflare Pages.
- `https://gateway.mestumre.dev` reaches the NoETL Gateway through Cloudflare
  Tunnel.
- Gateway remains a private `ClusterIP` service in GKE.
- NoETL server, workers, NATS, PgBouncer, and Cloud SQL access stay private.
- No GKE `LoadBalancer`, `NodePort`, or direct NoETL ingress is required.

The intended path is:

```text
Browser
  -> Cloudflare Pages: https://mestumre.dev
  -> Cloudflare Tunnel: https://gateway.mestumre.dev
  -> GKE Service: http://gateway.gateway.svc.cluster.local:8090
  -> GKE private services: noetl, nats, pgbouncer
```

Use Cloud Run only when Gateway must be operated outside Kubernetes. For the
standard NoETL GKE deployment, Cloudflare Tunnel is simpler because Gateway
stays close to NoETL server, NATS, PgBouncer, and worker traffic.

## Multiple Domains

Several domains can point to the same Gateway.

In Cloudflare Tunnel, add one public hostname per domain and route each of them
to the same internal Gateway service:

| Public hostname | Tunnel service |
|---|---|
| `gateway.mestumre.dev` | `http://gateway.gateway.svc.cluster.local:8090` |
| `gateway.example.com` | `http://gateway.gateway.svc.cluster.local:8090` |
| `api.example.net` | `http://gateway.gateway.svc.cluster.local:8090` |

Each GUI origin that calls Gateway must also be allowed by Gateway CORS and by
the auth provider:

```text
CORS_ALLOWED_ORIGINS=https://mestumre.dev,https://app.example.com
GATEWAY_PUBLIC_URL=https://gateway.mestumre.dev
```

If one Gateway serves multiple branded frontends, keep session-cookie domain,
callback URL, logout URL, and allowed web-origin configuration explicit per
domain. Do not use a wildcard unless the deployment is intentionally
multi-tenant and the auth policy is designed for that.

## Cloudflare API Tokens

Use Cloudflare **API tokens**, not the Global API Key.

Minimum token for local GUI deployment with `wrangler pages deploy`:

| Scope | Permission | Access |
|---|---|---|
| Account | Cloudflare Pages | Edit |

Recommended token if the same shell also updates DNS:

| Scope | Permission | Access |
|---|---|---|
| Account | Cloudflare Pages | Edit |
| Zone | DNS | Edit |

For tunnel automation through the Cloudflare API, use a separate narrowly
scoped token with one of the Cloudflare tunnel write permissions listed in the
Cloudflare Tunnel permissions documentation, such as `Cloudflare Tunnel Write`
or `Cloudflare One Connector: cloudflared Write`. If you create the tunnel
through the Cloudflare dashboard, the Kubernetes deployment only needs the
generated tunnel token.

Limit token resources:

- Account resources: include only the account that owns the Pages project and
  tunnel.
- Zone resources: include only the zones that own the public hostnames, such as
  `mestumre.dev`.

Export the token only in the shell that runs the deployment:

```bash
export CLOUDFLARE_API_TOKEN=...
```

Do not commit Cloudflare API tokens or tunnel tokens.

References:

- Cloudflare Pages Direct Upload: https://developers.cloudflare.com/pages/get-started/direct-upload/
- Cloudflare Pages API notes: https://developers.cloudflare.com/pages/configuration/api/
- Cloudflare Tunnel on Kubernetes: https://developers.cloudflare.com/tunnel/deployment-guides/kubernetes/
- Cloudflare Tunnel permissions: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-tunnel-permissions/
- Cloudflare API token permissions: https://developers.cloudflare.com/fundamentals/api/reference/permissions/

## Variables

```bash
export PROJECT_ID=noetl-demo-19700101
export REGION=us-central1
export CLUSTER=noetl-cluster
export DOMAIN=mestumre.dev
export GATEWAY_DOMAIN=gateway.mestumre.dev
export TUNNEL_NAME=noetl-gke-gateway
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
longer point to a GKE GUI LoadBalancer. If it returns Cloudflare `522`, check
the Cloudflare DNS record for the apex domain and remove the stale origin
target.

## Keep Gateway Private in GKE

Gateway should be deployed in GKE as a private service. Its Service type should
be `ClusterIP`:

```bash
gcloud container clusters get-credentials "$CLUSTER" \
  --region "$REGION" \
  --project "$PROJECT_ID"

kubectl -n gateway get svc
```

Expected:

```text
NAME            TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)
gateway         ClusterIP   ...             <none>        8090/TCP
```

If a public Gateway service exists from an older deployment, patch or redeploy
Gateway as `ClusterIP` before exposing it through Cloudflare Tunnel.

```bash
kubectl -n gateway patch svc gateway \
  --type='merge' \
  -p '{"spec":{"type":"ClusterIP"}}'
```

Also verify the NoETL server itself has no public service:

```bash
kubectl get svc -A | awk 'NR==1 || $5 != "<none>" {print}'
```

For this architecture, the output should not show public `EXTERNAL-IP` values
for `noetl`, `gateway`, `nats`, or `postgres`.

## Create a Cloudflare Tunnel

In Cloudflare Zero Trust:

1. Open **Networks** -> **Tunnels**.
2. Create a Cloudflared tunnel named `noetl-gke-gateway`.
3. Choose Docker as the connector environment.
4. Copy only the generated tunnel token value. It starts with `eyJ...`.

Store the token as a Kubernetes secret:

```bash
kubectl create namespace cloudflare --dry-run=client -o yaml | kubectl apply -f -

kubectl -n cloudflare create secret generic noetl-gke-gateway-tunnel \
  --from-literal=token='<CLOUDFLARE_TUNNEL_TOKEN>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Do not commit this token.

## Deploy cloudflared in GKE

Deploy at least two `cloudflared` replicas so one pod can roll without dropping
the tunnel:

```bash
cat <<'YAML' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: noetl-gke-gateway-tunnel
  namespace: cloudflare
  labels:
    app: noetl-gke-gateway-tunnel
spec:
  replicas: 2
  selector:
    matchLabels:
      app: noetl-gke-gateway-tunnel
  template:
    metadata:
      labels:
        app: noetl-gke-gateway-tunnel
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          imagePullPolicy: Always
          args:
            - tunnel
            - --no-autoupdate
            - run
            - --token
            - $(TUNNEL_TOKEN)
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: noetl-gke-gateway-tunnel
                  key: token
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
YAML

kubectl -n cloudflare rollout status deployment/noetl-gke-gateway-tunnel --timeout=180s
kubectl -n cloudflare logs deploy/noetl-gke-gateway-tunnel --tail=50
```

The logs should show that the tunnel connector registered successfully.

## Route Public Hostnames to Gateway

In the Cloudflare Tunnel public hostname settings, add:

```text
Public hostname: gateway.mestumre.dev
Service type:    HTTP
Service URL:     gateway.gateway.svc.cluster.local:8090
```

Add additional hostnames for each domain that should share this Gateway:

```text
Public hostname: gateway.example.com
Service type:    HTTP
Service URL:     gateway.gateway.svc.cluster.local:8090
```

Cloudflare creates the required DNS records for tunnel hostnames. If creating
DNS manually, the hostname should point to the tunnel target that Cloudflare
shows in the dashboard and remain proxied.

## Configure Gateway for GUI Origins

Gateway must allow the GUI origins that will call it. In GKE deployment values
or environment, set:

```text
CORS_ALLOWED_ORIGINS=https://mestumre.dev
GATEWAY_PUBLIC_URL=https://gateway.mestumre.dev
```

For multiple GUI domains:

```text
CORS_ALLOWED_ORIGINS=https://mestumre.dev,https://app.example.com
```

If auth redirects or session-cookie behavior depends on Gateway's public URL,
use the canonical Gateway hostname in `GATEWAY_PUBLIC_URL` and register all GUI
origins/callbacks with Auth0.

## Verify

Verify Gateway through the tunnel:

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

Verify the GUI:

```bash
curl -I https://mestumre.dev
```

Expected:

- `mestumre.dev` serves the Cloudflare Pages GUI.
- `gateway.mestumre.dev/health` returns `ok`.
- Gateway is reachable only through Cloudflare Tunnel.
- GKE has no public NoETL or Gateway services.

## Remove Old Public Exposure

Only do this after tunnel verification passes:

```bash
kubectl -n gateway patch svc gateway \
  --type='merge' \
  -p '{"spec":{"type":"ClusterIP"}}'

kubectl get svc -A | awk 'NR==1 || $5 != "<none>" {print}'
```

If an old static IP was reserved only for the previous public Gateway
LoadBalancer, release it after confirming no active DNS record uses it.

```bash
gcloud compute addresses list --project "$PROJECT_ID"
```

