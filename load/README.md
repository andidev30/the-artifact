# Load tests

[k6](https://grafana.com/docs/k6/latest/) scripts that measure how much one server handles, for the four scenarios in issue #23, and the tooling to run them against a production-like setup: the Docker image, Postgres and MinIO.

| Path | What |
| --- | --- |
| `scenarios/open-pages.js` | 1. Opening pages by link and signed in: the app shell, the page's details, `/api/artifacts/<slug>/v/<n>/` and every file it loads |
| `scenarios/publish.js` | 2. Publishing through MCP (`publish_artifact`) with large HTML and many files |
| `scenarios/gallery.js` | 3. The gallery of an organization with thousands of pages, paged with `X-Next-Cursor`, with search, folders and thumbnails |
| `scenarios/thumbnails.js` | 4. The thumbnail queue under 100 publishes a minute |
| `lib/` | Settings from the environment, MCP calls, generated pages, reading `/metrics` |
| `docker-compose.yml` | The image built from this checkout, Postgres and MinIO, with rate limits off and metrics on; Prometheus under the `metrics` profile |
| `sample-metrics.mjs` | Prints the server's key metrics as CSV every few seconds, for runs without Prometheus |
| `prometheus.yml` | Scrape config for the Prometheus in `docker-compose.yml` |
| `../apps/api/test/load/seed.ts` | Seeds people, an organization, pages and tokens (`pnpm --filter @the-artifact/api load:seed`) |

This folder is for people working on the server, so it lives here rather than in `docs/`, which ships inside the app.

## 1. Start a server

Install k6 (`brew install k6`, or run the `grafana/k6` image). Then, from the repository root:

```sh
docker compose -f load/docker-compose.yml up -d --build
```

The app listens on `http://localhost:8090`, Postgres on `localhost:55432` (database `artifact_load`) and MinIO on `localhost:59000` (bucket `artifact-load`). It has a project and volumes of its own, so it doesn't touch a real install or `pnpm services`. The image migrates the database as it starts.

Settings for the compose file, read from the environment or a `load/.env`:

| Variable | Default | What |
| --- | --- | --- |
| `LOAD_PORT` | `8090` | Host port of the app |
| `APP_CPUS`, `APP_MEMORY` | `2`, `2g` | Limits of the app container; set them to the machine you size for |
| `RATE_LIMITS` | `off` | k6 sends everything from one address and a few accounts, which the limits would stop. To include what the limits cost (one Postgres statement per MCP call and per publish), set high ones instead, e.g. `mcp=1000000/10m,publish=1000000/1h` |
| `METRICS_TOKEN` | `load-test-metrics` | Bearer token for `GET /metrics` |
| `CHROME_PATH` | the image's Chromium | Empty turns thumbnails off |

Against a staging server instead, set `RATE_LIMITS` and `METRICS_TOKEN` there the same way, and give the seeding script its database and bucket.

Stop and delete everything with `docker compose -f load/docker-compose.yml down -v`.

## 2. Seed it

The scripts need people who are signed in, MCP tokens, and pages. After `pnpm install`, the seeding script writes them with the server's own code into the database and bucket the server uses, and saves what k6 needs to `load/seed.json` (ignored by git):

```sh
DATABASE_URL=postgres://artifact:artifact@localhost:55432/artifact_load \
APP_URL=http://localhost:8090 \
S3_ENDPOINT=http://localhost:59000 S3_BUCKET=artifact-load \
S3_ACCESS_KEY_ID=artifact S3_SECRET_ACCESS_KEY=artifact-secret \
pnpm --filter @the-artifact/api load:seed --pages 5000
```

It refuses a database whose name doesn't contain `test`, `staging`, `stage`, `load`, `perf` or `bench`; pass `--allow-any-database` if yours is one under another name. Every run adds a new set (its own people, organization and pages), so it can run again without clearing anything.

| Option | Default | What |
| --- | --- | --- |
| `--users` | `20` | People, all in one organization; the first owns it |
| `--pages` | `5000` | Gallery pages in the organization, spread over the past year; a fifth are private to their owner |
| `--folders` | `25` | Folders holding 70% of the gallery pages |
| `--link-pages`, `--org-pages` | `100`, `100` | Pages to open: link-shared ones (personal workspaces) and organization-only ones, each a site of five files |
| `--site-kb` | `150` | Size of each of those sites. The server keeps 64 MB of blobs in memory (`apps/api/src/storage.ts`); make pages × size larger than that to measure reads from object storage |
| `--token-hours` | `24` | How long the sessions and tokens work |
| `--no-thumbnails` | off | Leave gallery pages without thumbnails, so opening the gallery queues renders for them (the backfill path) |
| `--out` | `load/seed.json` | Where to write the result |

How the scripts sign in: a real MCP client gets its token through OAuth 2.1 (dynamic registration, the browser sign-in and consent, then PKCE at `/oauth/token`), and a browser gets its session cookie from signing in. Neither can be clicked through by a load test, so the script inserts the rows those steps leave behind: a `sessions` row per person and two `oauth_tokens` access tokens (personal workspace and organization) for an OAuth client named `k6-load-test`, all stored hashed like real ones, as `apps/api/test/integration/helpers.ts` does. Everything after that goes through the real endpoints. Anyone with `seed.json` can act as these people until the tokens expire, so only seed test and staging servers.

The gallery pages share one small HTML blob and a placeholder thumbnail (a 1×1 PNG): the gallery reads rows, not content, and without thumbnails every first gallery load would queue renders.

## 3. Run a scenario

Every script takes `BASE_URL` (default `http://localhost:8090`), `VUS` (10), `DURATION` (`1m`), `THINK` (seconds between steps, 1) and `SEED` (absolute path, default `load/seed.json`) with `-e`:

```sh
k6 run -e VUS=50 -e DURATION=5m load/scenarios/open-pages.js
k6 run -e VUS=5 -e DURATION=5m load/scenarios/publish.js
k6 run -e VUS=30 -e DURATION=5m load/scenarios/gallery.js
k6 run -e METRICS_TOKEN=load-test-metrics -e DURATION=10m load/scenarios/thumbnails.js
```

`THINK=0` sends the next request as soon as the last one answers, to find the most a server does; with the default, each VU acts more like one person. Add `--out json=results.json` or `--summary-export summary.json` to keep the numbers. The thresholds are starting points; k6 exits non-zero when one fails.

### Opening pages

A visit loads `/a/<slug>`, `/api/config` and `/api/me` (the shell, skipped with `WITH_SHELL=false` against `pnpm dev`, whose API doesn't serve the web app), then `GET /api/artifacts/<slug>`, then the entry HTML as the sandboxed frame asks for it, then every file with no cookie. Signed-in visits open organization pages: the frame's request is redirected to `/v/<n>/~<link token>/` and the files load under the token.

| Setting | Default | What |
| --- | --- | --- |
| `LINK_SHARE` | `0.7` | Share of visits by link; the rest are signed in |
| `WITH_SHELL` | `true` | Load the app shell too |
| `UNIQUE_VISITORS` | `false` | Give every visit its own User-Agent. The server counts a visitor (address and browser) once per page every 30 minutes, and k6 sends one address, so by default almost no views are written; `true` counts every visit by link, the worst case for the database |

Thresholds: under 1% failed requests; p95 of the shell and details under 200 ms, of the entry HTML and files under 300 ms. Requests are tagged `step` (`shell`, `details`, `entry-redirect`, `entry`, `file`) and `via` (`link`, `signed-in`).

### Publishing

Each iteration calls `publish_artifact` with the whole page in the request: `HTML_KB` of HTML (500) and `FILES` files (20) of `FILE_KB` each (100), a third of them binary and sent as base64, which is about 2.8 MB per call. Half the calls add a version to the page the VU published before (`NEW_VERSION_SHARE`); every call names one of five folders. The HTML is new every time, so it is stored every time; `UNIQUE_FILES=true` makes the text files new too, otherwise they are stored once and found again. `WORKSPACE=personal` publishes to personal workspaces instead of the organization.

The limits are 2 MB of HTML, 5 MB per file, 10 MB and 100 files in all (`apps/api/src/files.ts`). The script uses the 2025-era request form (a plain `tools/call`, no `initialize`), which the server answers statelessly like the newer one.

Thresholds: under 1% failed, p95 of a publish under 5 s.

### Gallery

Each VU is one plain member of the organization (not its owner), so the listing also leaves out the private pages of others. A visit loads the folder list and the first `LIMIT` cards (50), their thumbnails, then scrolls `SCROLL` more pages (4, or `all` for the whole workspace) through `X-Next-Cursor`. `SEARCH_SHARE` (0.2) of visits search a title word with `?q=`, `FOLDER_SHARE` (0.2) open a folder. `WITH_THUMBNAILS=false` skips the images.

Thresholds: p95 of the first page under 500 ms, later pages under 400 ms, searches under 800 ms, folder list and thumbnails under 300 and 200 ms.

### Thumbnail queue

Publishes a new 30 KB page (`HTML_KB`) `RATE` times a minute (100) for `DURATION` (`10m`), while a second scenario reads `/metrics` every `SAMPLE_EVERY` seconds (5) until `DRAIN` (`3m`) after publishing stops. It needs `METRICS_TOKEN` and a server with thumbnails on. Renders run one at a time per server process, and past 1000 waiting versions the server stops queueing (`MAX_QUEUE` in `apps/api/src/thumbnails.ts`).

It reports `thumbnail_queue_length` (every sample), `thumbnail_queue_now` (the last one), `thumbnails_rendered` and `thumbnails_failed` (since the run started) and `thumbnail_render_mean_seconds` (mean since the server started). Thresholds: the queue's p95 under 100 and its maximum under 500, empty again by the end of the drain, publishes under 1 s at p95.

## 4. Watch the server

Two ways to see what the server does during a run. For a table in the terminal, with the same token:

```sh
node load/sample-metrics.mjs --url http://localhost:8090 --token load-test-metrics --every 5 | tee metrics.csv
```

Each line has requests per second and their mean time, 5xx per second, mean S3 time, database connections in use and the pool size, the thumbnail queue, renders per minute and their mean time, CPU, event loop lag, and memory. Start it before k6: the process metrics (CPU, memory, event loop) only start on the first scrape.

For graphs, start Prometheus with the compose file (`docker compose -f load/docker-compose.yml --profile metrics up -d`) and open `http://localhost:9090`. Against another server, change the target and token in `prometheus.yml`.

The metrics, from `apps/api/src/metrics.ts`:

| Metric | What to look for |
| --- | --- |
| `artifact_http_request_duration_seconds` (`method`, `route`, `status`) | Which route is slow. `histogram_quantile(0.95, sum by (le, route) (rate(artifact_http_request_duration_seconds_bucket[1m])))` |
| `artifact_db_pool_active`, `artifact_db_pool_max` | Active above max means queries wait for a connection. The pool is postgres.js's default of 10 per process |
| `artifact_s3_request_duration_seconds` (`operation`, `outcome`) | Object storage time and errors; few `get` calls means the blob cache answers |
| `artifact_thumbnail_queue_length` | Grows when publishes outpace renders |
| `artifact_thumbnail_render_duration_seconds` (`outcome`) | Render time, and failures |
| `artifact_process_cpu_seconds_total` | One Node process uses one core: `rate(...[1m])` near 1 means the process is the limit, whatever the machine has |
| `artifact_nodejs_eventloop_lag_p99_seconds` | Rising lag means JavaScript work (JSON, hashing, base64) holds up every request |
| `artifact_process_resident_memory_bytes`, `artifact_nodejs_heap_size_used_bytes` | Memory under large publishes |

Postgres and MinIO have their own views: `docker stats` for the containers, and `pg_stat_activity` in Postgres for what queries wait on.

Run k6 from another machine than the server when you can, or at least watch its CPU: a saturated load generator reports its own delays as the server's.

## Results

Copy this for each run, into the issue or a doc.

```md
### <scenario>, <date>

- Server: <commit or image tag>, <CPUs / memory of the app>, Postgres <version, where>, object storage <MinIO / S3, where>
- Settings: RATE_LIMITS=<...>, CHROME_PATH <on/off>, other changes
- Seed: <people> people, <gallery pages> gallery pages, <link/org pages> pages to open of <site KB> KB
- k6: <command>, from <machine>

| Measure | Value |
| --- | --- |
| Requests per second (sustained) | |
| p50 / p95 / p99 latency, per step | |
| Failed requests | |
| Most VUs before a threshold failed | |
| CPU of the app (cores) | |
| Database connections in use / pool size | |
| Event loop lag p99 | |
| Memory (RSS) at the end | |
| S3 p95 | |
| Thumbnail queue: max, and time to empty | |

What limited it: <CPU, the database pool, a query, S3, renders...>, and the evidence.

Follow-up issues: <links>
```
