# Kubernetes

The Artifact runs on k3s or any Kubernetes cluster in two ways, with the same image and the same settings as [Docker Compose](/docs/self-hosting):

- **The Helm chart** at `oci://ghcr.io/andidev30/charts/the-artifact`, published with every release. Settings are Helm values.
- **Plain manifests** in `deploy/kubernetes`, applied with kustomize, which `kubectl` includes. Settings go in one `app.env` file.

Both run the app, and for trying it out a bundled Postgres and MinIO. Both can use your own database and bucket instead.

## What you need

- A cluster with a default storage class for the bundled Postgres and MinIO volumes (k3s has one: `local-path`)
- An ingress controller for HTTPS (k3s includes Traefik), or your own way to route traffic to the app's service
- The [seccomp profile](#3-the-seccomp-profile) on every node that can run the app, or thumbnails turned off
- Access to `ghcr.io` from the cluster, or a registry of your own for your own builds
- For the chart, Helm 3.8 or later

## Install with Helm

The chart is published with every release from 0.2.0 on, under the release's version, and runs that release's image. Pick a release (see [Where releases are listed](/docs/upgrading#where-releases-are-listed)) and install it into its own namespace:

<!-- x-release-please-start-version -->

```sh
helm install the-artifact oci://ghcr.io/andidev30/charts/the-artifact --version 0.6.1 \
  --namespace the-artifact --create-namespace
kubectl -n the-artifact rollout status deploy/the-artifact
```

<!-- x-release-please-end -->

That is enough to try it: the app, Postgres and MinIO, with passwords the chart generates and keeps across upgrades, and no ingress. Forward a port and open `http://localhost:8080`, which is the address the chart assumes without an ingress or `appUrl`:

```sh
kubectl -n the-artifact port-forward svc/the-artifact 8080:80
```

Create the first account right away: it becomes the [instance admin](/docs/self-hosting#the-instance-admin), so it needs the setup code the app prints to its log:

```sh
kubectl -n the-artifact logs deploy/the-artifact -c app | grep "setup code"
```

Thumbnails are on by default, so the pod doesn't start until the [seccomp profile](#3-the-seccomp-profile) is on its node. On a cluster where you can't put files on the nodes, add `--set thumbnails.enabled=false`: the gallery then shows sketches, and the pod runs under the runtime's default profile.

With the release name `the-artifact`, the app's Deployment and Service are called `the-artifact`, so the commands on this page work as written. Another release name gives `<release>-the-artifact`.

### Values for a server

<!-- x-release-please-start-version -->

Put your values in a file and pass it with `-f`. `helm show values oci://ghcr.io/andidev30/charts/the-artifact --version 0.6.1` prints every value with what it does. The ones most servers set:

<!-- x-release-please-end -->

| Value | Default | What it does |
| --- | --- | --- |
| `appUrl` | `https://<ingress.host>`, or `http://localhost:8080` without an ingress | The address people use (`APP_URL`) |
| `ingress.enabled`, `ingress.host`, `ingress.className` | off | An Ingress for the host. `ingress.annotations` already raises nginx's body size limit to 20 MB for large pages. |
| `ingress.tls.enabled`, `ingress.tls.secretName` | on, `<release>-the-artifact-tls` | TLS for the host, from that secret. With cert-manager, add its issuer annotation and it fills the secret. |
| `contentOrigin` | none | `CONTENT_ORIGIN`: a [separate domain for pages](/docs/self-hosting#a-separate-domain-for-pages). With the ingress on, its host is added to the Ingress and its TLS hosts, so the certificate has to cover it too (cert-manager does that on its own). |
| `embedFrameAncestors` | any site | `EMBED_FRAME_ANCESTORS`: which sites may [embed pages](/docs/sharing#embedding) in a frame; `none` turns embedding off. See [Configuration](/docs/configuration#optional). |
| `trustProxy` | `true` with the ingress, `false` without | `TRUST_PROXY`, so [rate limits](/docs/configuration#rate-limits) see each visitor's address instead of the ingress controller's |
| `smtp.host`, `smtp.port`, `smtp.user`, `smtp.password`, `smtp.from` | no email | Email, as in the [configuration reference](/docs/configuration). Without `smtp.host` the server [runs without email](/docs/self-hosting#running-without-email). |
| `google.clientId`, `google.clientSecret` | off | **Continue with Google** |
| `thumbnails.enabled` | `true` | Gallery thumbnails. Needs the [seccomp profile](#3-the-seccomp-profile) on the nodes. |
| `thumbnails.concurrency` | `2` | `THUMBNAIL_CONCURRENCY`: how many thumbnails render at once, 1 to 8. A typical page renders in under a second, so 2 keeps up with about 150 new pages a minute; each extra render adds another Chromium page, so check `resources.limits` when you raise it. |
| `webConcurrency` | the CPU limit, or 1 without one | `WEB_CONCURRENCY`: how many worker processes serve requests. Empty follows `resources.limits.cpu` when you set one (one per core, up to 8), and runs one process otherwise. See [Using more cores](#using-more-cores). |
| `databasePoolMax` | 10 with one worker, about 20 in all with more | `DATABASE_POOL_MAX`: database connections per worker |
| `encryptionKey` | none | `ENCRYPTION_KEY`, recommended: the output of `openssl rand -base64 32`, which encrypts the keys the server keeps in its database. Or put `ENCRYPTION_KEY` in your `existingSecret`, which keeps it out of your values file. The chart never makes one, and the server needs it to start once set; see [Encryption key](/docs/configuration#encryption-key). |
| `metrics.token`, `metrics.serviceMonitor.enabled` | off | [Prometheus metrics](#health-checks-and-metrics) |
| `releaseCheck` | `true` | `false` sets `RELEASE_CHECK=false`: no daily request to GitHub for [new releases](/docs/upgrading#new-releases), for clusters without internet access |
| `rateLimits`, `workspaceQuota.maxPages`, `workspaceQuota.maxVersions`, `workspaceQuota.maxStorage` | the defaults | `RATE_LIMITS` and the [workspace quotas](/docs/configuration#workspace-quotas) |
| `existingSecret` | none | A Secret of yours whose keys become settings, e.g. `SMTP_PASS` or `GOOGLE_CLIENT_SECRET`. Its keys win over the same settings in values. |
| `extraEnv` | none | Any other setting from the [configuration reference](/docs/configuration), as `name` and `value` |
| `image.repository`, `image.tag` | `ghcr.io/andidev30/the-artifact`, the chart's release | The image. Set a tag only to run [your own build](#1-choose-the-image). |
| `resources`, `nodeSelector`, `tolerations`, `affinity` | 200m CPU and 384 MiB requested, 1.5 GiB limit | Where and how big the app's pod is |

For example, behind ingress-nginx with cert-manager, with email:

```yaml
appUrl: https://artifact.example.com
ingress:
  enabled: true
  className: nginx
  host: artifact.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
smtp:
  host: smtp.example.com
  user: artifact
  from: The Artifact <artifact@example.com>
# SMTP_PASS in a Secret you create: kubectl -n the-artifact create secret generic artifact-settings --from-literal=SMTP_PASS=...
existingSecret: artifact-settings
```

<!-- x-release-please-start-version -->

```sh
helm install the-artifact oci://ghcr.io/andidev30/charts/the-artifact --version 0.6.1 \
  --namespace the-artifact --create-namespace -f values.yaml
```

<!-- x-release-please-end -->

The app runs as one pod, and the chart has no replica count: the app migrates the database on start, so two pods must never start at once. Upgrades stop the old pod before the new one starts.

The chart runs the app as the image's `node` user, with a read-only root filesystem, no privilege escalation and no Linux capabilities. Chromium keeps its sandbox on under those settings; it writes only to `/tmp` and `/dev/shm`, which are volumes of the pod.

### Your own Postgres and object storage

The bundled Postgres and MinIO are one pod each, with a volume and no backups of their own. They are there to try the chart. For a server people rely on, use a managed Postgres and bucket, turn the bundled ones off and point the chart at yours:

```yaml
postgresql:
  enabled: false
externalDatabase:
  host: db.example.com
  user: artifact
  database: artifact
  params: sslmode=require
  # A Secret with the password under the key "password"
  existingSecret: artifact-db

minio:
  enabled: false
externalS3:
  # R2; leave it empty for AWS S3
  endpoint: https://<account-id>.r2.cloudflarestorage.com
  region: auto
  bucket: artifact
  # A Secret with S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY
  existingSecret: artifact-s3
```

Instead of the parts, `externalDatabase.url` takes a whole connection string, or `externalDatabase.existingSecretUrlKey` reads one from the Secret. A password read from a Secret goes into the URL as it is, so it has to be letters and digits, or percent-encoded. Behind a transaction-mode pooler (PgBouncer, Supabase on port 6543), set `externalDatabase.prepare: false`. Without S3 keys, the AWS SDK's credential chain applies; for an IAM role, put the role's annotation in `serviceAccount.annotations`. `externalS3.publicEndpoint` turns on [publishing by direct upload](/docs/publishing#publishing-by-direct-upload).

Values can also hold the passwords themselves (`externalDatabase.password`, `externalS3.secretAccessKey`, `smtp.password`); the chart puts them in a Secret. Keep such a values file out of git.

The app waits for whatever database and bucket it is given before it starts, and creates its tables and its bucket.

### Upgrading a Helm install

Read [Upgrading](/docs/upgrading) and take a [backup](#backups), then upgrade to the new chart with the same values:

<!-- x-release-please-start-version -->

```sh
helm upgrade the-artifact oci://ghcr.io/andidev30/charts/the-artifact --version 0.6.1 \
  --namespace the-artifact -f values.yaml
kubectl -n the-artifact rollout status deploy/the-artifact
```

<!-- x-release-please-end -->

Database changes apply when the new version starts. Generated passwords are kept. `helm uninstall` leaves the bundled Postgres and MinIO volumes and their password Secrets in place, so installing again with the same release name finds the data where it was; delete the `data-*` PersistentVolumeClaims and those Secrets to start over.

To move from the plain manifests to the chart, take a [backup](/docs/backups), install the chart, and [restore](/docs/backups#restore) into it. The two use different names for their resources, so one can't take over the other's.

## Install with the manifests

### 1. Choose the image

Each release is published as `ghcr.io/andidev30/the-artifact`, for `linux/amd64` and `linux/arm64`, tagged with its version (`0.2.0`), its major.minor (`0.2`, which moves to each new patch) and `latest`; see [Image tags](/docs/upgrading#image-tags). `deploy/kubernetes/kustomization.yaml` names the image under `images`, pinned to the release you checked out. Keep it pinned, to the exact version or its major.minor:

```yaml
images:
  - name: the-artifact
    newName: ghcr.io/andidev30/the-artifact
    newTag: '0.2'
```

To run your own build instead, build it from the repository and push it to your registry:

```sh
docker build -t registry.example.com/the-artifact:latest .
docker push registry.example.com/the-artifact:latest
```

Then name that one under `images`:

```yaml
images:
  - name: the-artifact
    newName: registry.example.com/the-artifact
    newTag: latest
```

With the chart, set `image.repository` and `image.tag` to your build instead.

On a single-node k3s you can skip the registry and import your build into the node's containerd, with `newName: the-artifact` and `newTag: latest`:

```sh
docker build -t the-artifact:latest .
docker save the-artifact:latest | sudo k3s ctr images import -
```

### 2. Configure it

```sh
cp deploy/kubernetes/app.env.example deploy/kubernetes/app.env
```

`app.env` holds every setting, in one Secret: the app reads all of it, and the bundled Postgres and MinIO read their passwords from it. Change before the first apply:

| Setting | What to put there |
| --- | --- |
| `APP_URL` | The address people use, e.g. `https://artifact.example.com`. |
| `DATABASE_URL`, `POSTGRES_PASSWORD` | The same new password in both lines, letters and digits only. |
| `S3_SECRET_ACCESS_KEY` | A new password; it is also the bundled MinIO's password. |
| `SMTP_*`, `GOOGLE_*` | Optional, as in the [configuration reference](/docs/configuration). Without `SMTP_HOST` the server [runs without email](/docs/self-hosting#running-without-email). |
| `ENCRYPTION_KEY` | Recommended. The output of `openssl rand -base64 32`, kept apart from your backups too: the server needs it to start. See [Encryption key](/docs/configuration#encryption-key). |
| `TRUST_PROXY` | Already `true`, since people reach the app through the ingress. It makes [rate limits](/docs/configuration#rate-limits) see each visitor's address instead of the ingress controller's. Keep the Service a `ClusterIP`: exposed as a `NodePort` or `LoadBalancer`, anyone reaching it past the ingress could claim any address. |

The database and MinIO keep the passwords they were created with, so changing them later means changing them inside Postgres and MinIO too. `app.env` is ignored by git.

In `deploy/kubernetes/ingress.yaml`, set the host to the one in `APP_URL`. With cert-manager, uncomment the issuer annotation to get a certificate; otherwise put your certificate in the `the-artifact-tls` secret. To serve pages from a [separate domain](/docs/self-hosting#a-separate-domain-for-pages), set `CONTENT_ORIGIN` in `app.env` and uncomment the second host in `ingress.yaml`, under both `rules` and `tls`.

### 3. The seccomp profile

This applies to both the chart and the manifests. Gallery thumbnails are rendered by Chromium inside the app, with Chromium's sandbox on, because the pages are untrusted. The sandbox needs a few system calls the default seccomp profile forbids, so the pod runs with the profile from `deploy/seccomp-chromium.json` (the runtime's default profile plus `clone`, `unshare` and `setns`; see [Security](/docs/security)).

Kubernetes loads it from each node, so copy it onto every node that can run the app:

```sh
sudo mkdir -p /var/lib/kubelet/seccomp/profiles
sudo cp deploy/seccomp-chromium.json /var/lib/kubelet/seccomp/profiles/the-artifact-chromium.json
```

Without the file, the pod doesn't start, and `kubectl describe pod` says it couldn't load the seccomp profile. When you can't put files on the nodes (a managed cluster, say), run without thumbnails instead: set `thumbnails.enabled=false` in the chart, or uncomment the `patches` lines in `kustomization.yaml`. The gallery then shows sketches, and the pod uses the runtime's default profile.

### 4. Apply it

```sh
kubectl apply -k deploy/kubernetes
kubectl -n the-artifact rollout status deploy/the-artifact
```

Every container runs as a user other than root, with no Linux capabilities and a read-only root filesystem, like the chart's. `postgres.yaml` and `minio.yaml` each carry a NetworkPolicy that lets only the app's pod reach the database and MinIO, since the app's S3 key is MinIO's root account; the network plugin enforces them (k3s's does out of the box, and so do Calico and Cilium).

The app waits for Postgres and MinIO before it starts, then creates its tables and bucket. Open `APP_URL` and create the first account: it becomes the [instance admin](/docs/self-hosting#the-instance-admin), so it needs the setup code the app prints to its log:

```sh
kubectl -n the-artifact logs deploy/the-artifact -c app | grep "setup code"
```

To try it before DNS and HTTPS are in place, forward a port and open `http://localhost:8080` (set `APP_URL=http://localhost:8080` for that, since sign-in links are built from it):

```sh
kubectl -n the-artifact port-forward svc/the-artifact 8080:80
```

### Using your own Postgres or object storage

Put the connection in `app.env` and remove the bundled service from `resources` in `kustomization.yaml`:

- **Postgres**: set `DATABASE_URL` and remove `postgres.yaml`. `POSTGRES_PASSWORD` is then unused.
- **S3, R2 or your own MinIO**: set the five `S3_*` settings and remove `minio.yaml`. `app.env.example` has the values for R2 and AWS.

The app waits for whatever `DATABASE_URL` and `S3_ENDPOINT` point at, so nothing else changes.

## Running it

The app runs as one pod, and updates replace it rather than rolling: it migrates the database on start. With the manifests, keep `replicas: 1`; the chart has no other choice.

### Using more cores

Since the pod doesn't scale out, it scales up: one Node.js process uses at most about one and a half cores, so the app can start several [worker processes](/docs/configuration#more-than-one-worker) in the pod. Both the chart and the manifests run one by default, because the pod has no CPU limit and the node's core count says nothing about what the pod may use. Each worker takes about 250 MiB of memory.

- **Chart:** set `resources.limits.cpu` (e.g. `4`), and the app starts one worker per core, up to 8; or set `webConcurrency` yourself. Raise `resources.limits.memory` by about 256Mi per worker, and the CPU request to what you expect it to use.
- **Manifests:** change `WEB_CONCURRENCY` in the `env` of the app container in `app.yaml`, and its `resources` to match.

Each worker has its own database pool (`DATABASE_POOL_MAX`); with the defaults, the pod opens at most 10 connections with one worker and about 20 with more.

Commands from the other pages run with `kubectl exec` (with a Helm release named something other than `the-artifact`, use `deploy/<release>-the-artifact`):

```sh
# Make someone an instance admin (prints a password link on a server without email)
kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/make-admin.js you@example.com

# Reset someone's two-factor sign-in when no other admin can
kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/reset-two-factor.js you@example.com

# Remove unreferenced content now instead of at the next sweep
kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/sweep-storage.js

# Index every page for search now instead of a few hundred per sweep
kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/backfill-search.js
```

### Health checks and metrics

The pod's startup and liveness probes call `/healthz`, which only says the process answers, and its readiness probe calls `/readyz`, which also checks Postgres and object storage. So while the database is down the pod leaves the service but isn't restarted. For Prometheus metrics, set `METRICS_TOKEN` in `app.env` (or `metrics.token` in the chart), apply again, and scrape `http://the-artifact.the-artifact.svc/metrics` with the token as a bearer token; see [Health checks and metrics](/docs/self-hosting#health-checks-and-metrics).

With the Prometheus Operator, the chart makes the ServiceMonitor for you with `metrics.serviceMonitor.enabled=true`. It reads the token from the chart's Secret, or from `METRICS_TOKEN` in `existingSecret`; without either, the chart generates one. Add the labels your Prometheus selects ServiceMonitors by under `metrics.serviceMonitor.labels`.

### Updating

With the chart, see [Upgrading a Helm install](#upgrading-a-helm-install). With the manifests and the published image, read [Upgrading](/docs/upgrading) and take a [backup](#backups), then check out the new release, which names it in `newTag` (or set `newTag` yourself), and run `kubectl apply -k deploy/kubernetes`. Database changes apply when the new version starts.

With your own builds, give every build its own tag, so the cluster pulls it instead of reusing the image it has:

```sh
git pull
TAG=$(git rev-parse --short HEAD)
docker build -t registry.example.com/the-artifact:$TAG . && docker push registry.example.com/the-artifact:$TAG
# In kustomization.yaml, set newTag: <the tag>, then
kubectl apply -k deploy/kubernetes
```

On k3s with an imported image, import the new build under the same tag and restart instead: `kubectl -n the-artifact rollout restart deploy/the-artifact`.

A changed `app.env` gets a new Secret name, so `kubectl apply -k` restarts the app with the new settings by itself.

### Backups

The commands below are for the bundled Postgres and MinIO; with your own, use their backups. With the chart, the pods are named after the release: `the-artifact-postgresql-0` and the service `the-artifact-minio` for the release `the-artifact`, where the manifests have `postgres-0` and `minio`.

The database, with `pg_dump` in the Postgres pod:

```sh
kubectl -n the-artifact exec postgres-0 -- pg_dump -U artifact -Fc artifact > artifact-$(date +%F).dump
```

The content, with the MinIO client on your machine, through a port-forward. The password is `S3_SECRET_ACCESS_KEY` from `app.env`; with the chart, read it with `kubectl -n the-artifact get secret the-artifact-minio -o jsonpath='{.data.root-password}' | base64 -d`.

```sh
kubectl -n the-artifact port-forward svc/minio 9000:9000 &
mc alias set artifact http://localhost:9000 artifact '<password>'
mc mirror --overwrite artifact/artifact backups/content
```

Dump the database first, then copy the content, as in [Backup and restore](/docs/backups), which also covers restoring.
