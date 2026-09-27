# Kubernetes

`deploy/kubernetes` runs The Artifact on k3s or any Kubernetes cluster with kustomize, which `kubectl` includes: the app, Postgres and MinIO in the namespace `the-artifact`. It is the same image and the same settings as [Docker Compose](/docs/self-hosting); only how they are passed differs.

## What you need

- A cluster with a default storage class for two volumes (k3s has one: `local-path`)
- An ingress controller for HTTPS (k3s includes Traefik), or your own way to route traffic to the `the-artifact` service
- Access to `ghcr.io` from the cluster, or a registry of your own for your own builds

## 1. Choose the image

Every commit to `main` is published as `ghcr.io/andidev30/the-artifact`, for `linux/amd64` and `linux/arm64`: `latest` follows `main`, and each release is also tagged with its version (`1.2.0`, `1.2`). Name it under `images` in `deploy/kubernetes/kustomization.yaml`, pinned to a version:

```yaml
images:
  - name: the-artifact
    newName: ghcr.io/andidev30/the-artifact
    newTag: '1.2.0'
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

On a single-node k3s you can skip the registry and import your build into the node's containerd, with `newName: the-artifact` and `newTag: latest`:

```sh
docker build -t the-artifact:latest .
docker save the-artifact:latest | sudo k3s ctr images import -
```

## 2. Configure it

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

The database and MinIO keep the passwords they were created with, so changing them later means changing them inside Postgres and MinIO too. `app.env` is ignored by git.

In `deploy/kubernetes/ingress.yaml`, set the host to the one in `APP_URL`. With cert-manager, uncomment the issuer annotation to get a certificate; otherwise put your certificate in the `the-artifact-tls` secret.

## 3. The seccomp profile

Gallery thumbnails are rendered by Chromium inside the app, with Chromium's sandbox on, because the pages are untrusted. The sandbox needs a few system calls the default seccomp profile forbids, so the pod runs with the profile from `deploy/seccomp-chromium.json` (the runtime's default profile plus `clone`, `unshare` and `setns`; see [Security](/docs/security)).

Kubernetes loads it from each node, so copy it onto every node that can run the app:

```sh
sudo mkdir -p /var/lib/kubelet/seccomp/profiles
sudo cp deploy/seccomp-chromium.json /var/lib/kubelet/seccomp/profiles/the-artifact-chromium.json
```

Without the file, the pod doesn't start, and `kubectl describe pod` says it couldn't load the seccomp profile. When you can't put files on the nodes (a managed cluster, say), run without thumbnails instead: uncomment the `patches` lines in `kustomization.yaml`. The gallery then shows sketches, and the pod uses the runtime's default profile.

## 4. Apply it

```sh
kubectl apply -k deploy/kubernetes
kubectl -n the-artifact rollout status deploy/the-artifact
```

The app waits for Postgres and MinIO before it starts, then creates its tables and bucket. Open `APP_URL` and create the first account: it becomes the [instance admin](/docs/self-hosting#the-instance-admin). Do this before you share the address.

To try it before DNS and HTTPS are in place, forward a port and open `http://localhost:8080` (set `APP_URL=http://localhost:8080` for that, since sign-in links are built from it):

```sh
kubectl -n the-artifact port-forward svc/the-artifact 8080:80
```

## Running it

The app runs as one pod, and updates replace it rather than rolling: it migrates the database on start, and keeps the wrong-password limits in memory. Keep `replicas: 1`.

Commands from the other pages run with `kubectl exec`:

```sh
# Make someone an instance admin (prints a password link on a server without email)
kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/make-admin.js you@example.com

# Remove unreferenced content now instead of at the next sweep
kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/sweep-storage.js
```

### Health checks and metrics

The pod's startup and liveness probes call `/healthz`, which only says the process answers, and its readiness probe calls `/readyz`, which also checks Postgres and object storage. So while the database is down the pod leaves the service but isn't restarted. For Prometheus metrics, set `METRICS_TOKEN` in `app.env`, apply again, and scrape `http://the-artifact.the-artifact.svc/metrics` with the token as a bearer token; see [Health checks and metrics](/docs/self-hosting#health-checks-and-metrics).

### Updating

With the published image, set `newTag` to the new version and run `kubectl apply -k deploy/kubernetes`. Database changes apply when the new version starts.

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

The database, with `pg_dump` in the Postgres pod:

```sh
kubectl -n the-artifact exec postgres-0 -- pg_dump -U artifact -Fc artifact > artifact-$(date +%F).dump
```

The content, with the MinIO client on your machine, through a port-forward (use the `S3_SECRET_ACCESS_KEY` from `app.env`):

```sh
kubectl -n the-artifact port-forward svc/minio 9000:9000 &
mc alias set artifact http://localhost:9000 artifact '<S3_SECRET_ACCESS_KEY>'
mc mirror --overwrite artifact/artifact backups/content
```

Dump the database first, then copy the content, as in [Backup and restore](/docs/backups), which also covers restoring.

## Using your own Postgres or object storage

Put the connection in `app.env` and remove the bundled service from `resources` in `kustomization.yaml`:

- **Postgres**: set `DATABASE_URL` and remove `postgres.yaml`. `POSTGRES_PASSWORD` is then unused.
- **S3, R2 or your own MinIO**: set the five `S3_*` settings and remove `minio.yaml`. `app.env.example` has the values for R2 and AWS.

The app waits for whatever `DATABASE_URL` and `S3_ENDPOINT` point at, so nothing else changes.
