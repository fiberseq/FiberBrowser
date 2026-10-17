# A public FiberBrowser server

This guide publishes your datasets on the web, as the UCSC Genome Browser or
igv.js do. Anyone with the link can browse the datasets and analyse their reads
in their own session. Paper reviewers can use it too. Visitors can't upload
files, open URLs or reach anything on the server outside the catalog.

The setup runs on one cloud VM or institutional VM:

- **FiberBrowser** runs in `--public` mode, one or more processes.
- **Caddy** sits in front. It gets and renews the HTTPS certificate, compresses
  responses, and keeps each visitor on one FiberBrowser process.

You can run both with Docker Compose (the files are in `deploy/`) or with
systemd.

- [What a visitor can and can't do](#what-a-visitor-can-and-cant-do)
- [Prepare your datasets](#prepare-your-datasets)
- [Deploy with Docker Compose](#deploy-with-docker-compose)
- [Deploy with systemd](#deploy-with-systemd-no-docker)
- [Operate: firewall, logs, updates, monitoring](#operate)
- [Sizing](#sizing)
- [Limits and settings](#limits-and-settings)
- [Security design](#security-design)
- [Load testing your server](#load-testing-your-server)

## What a visitor can and can't do

A visitor can:

- Browse the catalog's datasets and reference tracks, and the genome's genes
  and sequence.
- Use the analysis panels on their own session: clustering, peak scans,
  co-accessibility, footprint classes (small regions, with a server-set
  budget), motif tracks from the bundled JASPAR database or a typed sequence
  or matrix, and figure export.
- Save their view as a session file, which downloads to their own computer.

A visitor can't:

- Upload files. Every multipart or form body is refused, on every route.
- Open a path or URL, including "Add track" by URL and the UCSC, ENCODE and
  ChIP-Atlas track search.
- Reach anything outside the catalog: server files, processes, credentials,
  Copilot, primer design (BLAST), Jupyter, or the S3 browser.
- See the API documentation (`/docs` and `/openapi.json` return 404) or
  server paths (responses show file names only).
- Change what other visitors see. Each visitor has their own session.

Remote sources that **you** list in the catalog (https or s3) are loaded by
the server. That is the only way a public server fetches anything.

## Prepare your datasets

### The catalog

`catalog.json` lists what visitors can open (see the
[schema](../reference.md#dataset-catalog)):

```jsonc
{
  "name": "Smith et al. 2026: DAF-seq at the NAPA promoter",
  "genome": "hg38",                       // loaded for everyone on first use
  "tracks": [                             // reference tracks (bigWig/bigBed)
    { "path": "tracks/ctcf.bw", "label": "CTCF ChIP" }
  ],
  "groups": [
    { "name": "K562 DAF-seq",
      "datasets": [
        { "path": "k562/k562_nucleosome.bb", "label": "K562 (BigBed)" },
        { "url": "https://my-bucket.s3.amazonaws.com/k562.calls.bam", "label": "K562 (BAM)" }
      ] }
  ]
}
```

- A `path` is relative to the catalog file's folder, or absolute. In Docker
  the data folder is mounted at `/data` with `catalog.json` at its top, so a
  relative path such as `k562/k562_nucleosome.bb` resolves to
  `/data/k562/k562_nucleosome.bb`; an absolute one must start with `/data/`.
- A `url` can be `https://…` or `s3://…`. Visitors can see these URLs. List
  only sources you would publish anyway: no presigned URLs, no internal hosts.
- If you set a genome, the first visitor downloads it (FASTA and GENCODE GTF,
  about 1 GB for hg38) into the cache volume (`/home/fiberbrowser/.fiberhmm`).
  One download runs at a time within a process, but not across processes:
  with several replicas, two first visitors could both start it. For a public
  server, don't use the download:
  - Put the FASTA (with its `.fai`) and the GTF in the data folder, leave
    `genome` out of the catalog, and start the server with
    `--fasta /data/ref/hg38.fa --gtf /data/ref/gencode.gtf`. In
    `docker-compose.yml`, add them to the service's
    `command: ["--catalog", "/data/catalog.json", "--fasta", ..., "--gtf", ...]`.
  - Or start with `FIBERBROWSER_REPLICAS=1`, open the server once so it
    downloads the genome, then scale up.
- `deploy/demo/catalog.json` is a working example that points at the demo BAM
  shipped with FiberBrowser.

### Prefer BigBed

A catalog dataset can be a FiberHMM BAM or the BigBed tracks made from one.
BigBeds are faster to serve: each visitor's first view of a region decodes
the reads, and BigBed skips the BAM's tag parsing. On the demo, a first view
took 312 ms from BigBed and 738 ms from BAM, and used 35 MB of memory per
visitor instead of 43 MB. On a busy server, that difference is the headroom.

Make the BigBeds with FiberHMM (`bedToBigBed` from UCSC must be on `PATH`):

```bash
fiberhmm-extract -i calls/k562.calls.bam -o tracks/k562 -c 4
# -> tracks/k562/k562.calls_nucleosome.bb, _msp.bb, _tf.bb, _m6a.bb (DAF: _deam.bb)
```

List the `*_nucleosome.bb` file in the catalog. FiberBrowser picks up the
sibling `_msp`, `_tf`, `_m6a` and `_deam` files next to it as layers of the
same dataset. Keep the BAM instead when visitors need something only the BAM
has, such as footprint classes on the default recaller engine.

### Remote files (S3 or any HTTPS server)

BAM, BAI and BigBed files are read with HTTP range requests, so you don't need
to copy them to the server. This was checked for 3.0:

- A BAM over plain HTTP from a server with range support: the catalog dataset
  loaded and its reads drew.
- A BAM over HTTPS (GIAB, NCBI): 306 reads in 2.7 s.
- A BigBed over HTTPS (UCSC `hgdownload`): 2.7 s for the first query.
- A public S3 bucket, as `https://bucket.s3.amazonaws.com/key`. An
  `s3://bucket/key` entry is read the same way: FiberBrowser turns it into
  an HTTPS URL with boto3 (pre-signed when the server has credentials for a
  private bucket), so it also works for Cloudflare R2, Backblaze B2 or MinIO
  with the catalog's `"s3": {"endpoint_url": ...}` block. See
  [Lab data on S3](../workflows/s3-lab-data.md).

The server downloads each remote BAM's index once per file version into
`~/.fiberhmm/remote_cache` (in the image, the `fiberbrowser-cache` volume;
`FIBERBROWSER_REMOTE_CACHE` moves it). Remote reads are slower than local
ones. For a busy server, copy the files to the VM's disk.

## Deploy with Docker Compose

You need a Linux VM with Docker, a DNS name pointing at it, and ports 80 and
443 open.

1. Put `catalog.json` at the top of one folder with the files it lists, for
   example `/srv/fiberbrowser-data/catalog.json`. Write the paths relative to
   the catalog (or as `/data/...`, where the folder appears in the container).
2. Create `deploy/.env`:

   ```bash
   FIBERBROWSER_DOMAIN=browser.example.org
   FIBERBROWSER_DATA=/srv/fiberbrowser-data
   FIBERBROWSER_VERSION=3.0.1          # the image tag
   FIBERBROWSER_REPLICAS=2             # FiberBrowser processes (see Sizing)
   FIBERBROWSER_REPLICA_MEMORY=6g      # memory limit per process
   FIBERBROWSER_PUBLIC_MEMORY_MB=4500  # stop admitting visitors before that limit
   ```

3. Start the containers:

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
   ```

   To build the image from this checkout instead, add `--build` to `up`. The
   build installs FiberHMM from PyPI. To use a local FiberHMM build instead,
   put its wheel in `deploy/wheels/` first
   (`pip wheel --no-deps -w deploy/wheels /path/to/FiberHMM`); the build
   prefers wheels there.

4. Open `https://browser.example.org`. Caddy gets the certificate the first
   time; this takes a few seconds.

For a server only reviewers can open, uncomment the `basic_auth` block in
`deploy/Caddyfile` and set `FIBERBROWSER_PASSWORD_HASH` in `.env`. Make the
hash with `docker run --rm caddy:2 caddy hash-password`.

How the containers are set up:

- FiberBrowser listens only on the compose network, never on the host.
- The data is mounted read-only, the container's filesystem is read-only, and
  `/tmp` is a 2 GB tmpfs. The container holds no cloud credentials.
- The processes trust `X-Forwarded-For` only from Caddy's network
  (`FIBERBROWSER_TRUSTED_PROXIES=172.30.0.0/24`), so the rate limits count
  real visitors.
- Caddy balances over the replicas with `lb_policy cookie`. A visitor's
  session lives in one process's memory, so each browser stays on its
  process. Caddy finds the replicas by DNS and can't run active health
  checks on them. Instead, a replica that fails a request is avoided for 30
  seconds and the request is retried on another one (passive checks). Docker
  checks each container at `/api/health` (its `HEALTHCHECK`, shown by
  `docker compose ps`).
- The logs rotate at 20 MB × 5 files per container (Docker's `json-file`
  driver).

Try the image on its own, without Caddy:

```bash
docker run --rm -p 127.0.0.1:8000:8000 ghcr.io/fiberseq/fiberbrowser:3.0.1 \
  --catalog /opt/fiberbrowser-demo/deploy/demo/catalog.json
```

## Deploy with systemd (no Docker)

On a VM with Python 3.10 or newer:

```bash
sudo useradd --system --home /srv/fiberbrowser fiberbrowser
sudo mkdir -p /srv/fiberbrowser/{data,cache} && sudo chown -R fiberbrowser: /srv/fiberbrowser
sudo -u fiberbrowser python3 -m venv /srv/fiberbrowser/venv
sudo -u fiberbrowser /srv/fiberbrowser/venv/bin/pip install fiberbrowser==3.0.1
sudo cp deploy/systemd/fiberbrowser@.service /etc/systemd/system/
# edit FIBERBROWSER_ALLOWED_HOSTS and the catalog path in the unit, then:
sudo systemctl daemon-reload
sudo systemctl enable --now fiberbrowser@8001 fiberbrowser@8002
```

Each instance is one process on `127.0.0.1:<port>`. It trusts forwarding
headers only from `127.0.0.1` (Caddy on the same machine). Install Caddy
from your distribution or caddyserver.com, then set `/etc/caddy/Caddyfile`:

```caddyfile
browser.example.org {
	encode zstd gzip
	request_body {
		max_size 4MB
	}
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8001 127.0.0.1:8002 {
		lb_policy cookie fb_replica
		health_uri /api/health
		transport http {
			read_timeout 5m
		}
	}
}
```

Then `sudo systemctl reload caddy`. journald keeps the logs; set its size
with `SystemMaxUse=` in `/etc/systemd/journald.conf`.

## Operate

**Firewall.** Open 80/tcp (certificates and the redirect to HTTPS), 443/tcp
and 443/udp (HTTP/3), and SSH from your own addresses only. Keep port 8000,
and your 800x ports under systemd, closed to the outside. With `ufw`:

```bash
sudo ufw default deny incoming
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
```

Docker publishes ports around `ufw`. The compose file publishes only Caddy's
80 and 443, so this is safe. Don't add `ports:` to the fiberbrowser service.

**Updating.** Set `FIBERBROWSER_VERSION` to the new tag, then run
`docker compose ... pull && docker compose ... up -d`. Under systemd, run
`pip install -U fiberbrowser==X.Y.Z` and restart the instances one at a time.
A restart ends the sessions of the visitors on that process: their page
reloads with the catalog closed. Update at a quiet hour.

**Monitoring.** `GET /api/health` returns `{"status": "ok"}`. It needs no
session and is never rate-limited away. Point an uptime checker at
`https://browser.example.org/api/health`. Docker's `HEALTHCHECK` uses it,
and so do Caddy's active health checks under systemd, where the upstreams are
listed by address. (With Docker Compose, Caddy finds the replicas by DNS and
uses passive checks instead.) With several replicas, the uptime checker's
request reaches whichever replica Caddy picks: `docker compose ps` shows each
container's health. The logs record, with a request ID:

- every refused request (429 and 503 carry a `Retry-After` header);
- every server error (visitors see only a generic message and that ID);
- memory pressure: `resident memory … cleared … new sessions wait`.

To find the full error behind a visitor's report, `grep` the logs for the ID
they quote.

**Backups.** Nothing on the server changes, so back up the data folder and
`catalog.json`. Visitor sessions live in memory only.

## Sizing

Two things limit a FiberBrowser process:

- **CPU.** Each process uses about **one core** for Python work (the GIL).
  When a visitor moves to a new region, the process decodes that region's
  reads, which takes about 0.3–0.7 s of CPU for the demo's 3,200-read locus,
  plus a peak scan. When many visitors open the same view (a paper's figure
  link), the server computes it once and shares it with everyone who arrives
  meanwhile.
- **Memory.** Each visitor who has moved around recently holds their reads
  in memory: 40–120 MB for the demo locus, more for deeper loci. It is freed
  after two idle minutes (`idle_cache_seconds`).

Guidance:

- **Replicas.** Run one replica per two vCPUs.
- **Memory limit per replica.** Allow 1 GB plus about 100 MB for each visitor
  you expect to be active at once on that replica. Set
  `FIBERBROWSER_PUBLIC_MEMORY_MB` to about 75 % of the limit: above it, the
  process drops idle visitors' caches and new visitors wait instead of the
  process being killed.
- **Examples.** 4 vCPU / 16 GB with 2 replicas at 6 GB suits a paper's
  reviewers and readers: ~20–30 visitors active at once. 8 vCPU / 32 GB with
  4 replicas at 7 GB handles about 60 active visitors at once, as measured
  below.

**Measured** (`scripts/load_test_public.py`, demo catalog, on a 16-core
workstation that other jobs kept at a load average of about 30).

Simulated visitors each open the page, load the dataset, then change view
every 5–20 s. 70 % of view changes stay at the shared locus; the rest pan
away.

The abusive clients, added in a second phase:

- one address running 20 analyses at a time (clustering with k=500, t-SNE,
  peak scans, co-accessibility at 1-bp bins, 12,000-px figures);
- one address without cookies, flooding;
- one address asking for whole chromosomes and 3 MB bodies, and uploading.

| Setup | Visitors | Failed visitor requests | Reads p50 / p95 | Page p95 | Other views p95 | Memory (all processes) |
|---|---|---|---|---|---|---|
| 1 process | 30 | 0 % | 3.6 s / 27 s | 185 ms | 2.2 s | 2.8 GB |
| 1 process + abusers | 30 | 0.35 % | 4.4 s / 31 s | 593 ms | 3.8 s | 5.2 GB |
| 4 processes (Caddy, sticky) | 60 | 0 % | 45 ms / 13.8 s | 89 ms | 182 ms | 7.2 GB |
| 4 processes + abusers | 60 | 0 % | 63 ms / 11.3 s | 2.4 s | 2.2 s | 13.7 GB (120 sessions) |

- **One process.** It saturates at about one core: 30 people changing view
  every few seconds is too many for one replica.
- **Four processes.** With 60 visitors, a typical view came back in about
  50 ms. The p95 is the first view of visitors who all arrived within the
  same 5 seconds.
- **Abusers.** They sent about 49,000 requests in 94 s. Their allowance went
  through: 45 analyses and 96 sessions. Everything else was refused with 429,
  413 or 415. No visitor request failed.
- **Memory.** The macOS test machine can't return freed memory to the
  system, so its numbers are high. On Linux, the server hands freed memory
  back (`malloc_trim`) after it drops idle caches.

## Limits and settings

Every limit is a plain option. Set it one of three ways (a flag on the
command line wins over the file; `fiberbrowser --help` lists every flag):

- a command-line flag, `--public-<name>`;
- an environment variable, `FIBERBROWSER_PUBLIC_<NAME>`;
- in a server config file with `profile = "public"`
  (`fiberbrowser serve --config fiberbrowser-server.toml`, see
  [Deploying on a server](index.md)), under `[limits]` by the same name:

  ```toml
  profile = "public"

  [data]
  catalog = "/data/catalog.json"

  [auth]
  trusted_proxies = ["172.30.0.0/24"]   # the same list as --trusted-proxy

  [limits]
  rate_per_minute = 600
  heavy_concurrent = 2
  memory_mb = 4500
  ```

  `fiberbrowser check-config` rejects unknown names.
  (`services.public_limits.limit_names()` lists them.)

| Setting | Default | What it limits |
|---|---|---|
| `rate_per_minute`, `rate_burst` | 1200, 300 | requests per client address (IPv6: per /64); `/assets` don't count |
| `heavy_per_minute`, `heavy_burst` | 120, 30 | analysis requests per client (clustering, scans, co-accessibility, figures, footprint classes, exports) |
| `heavy_concurrent_per_ip`, `heavy_concurrent` | 3, half the cores | analyses running at once per client, server-wide; beyond them, requests wait `heavy_wait_seconds` (15) and then get 503 |
| `heavy_timeout_seconds` | 180 | an analysis still running after this gets 503 (its slot stays taken until it ends) |
| `read_concurrent`, `read_concurrent_per_ip`, `read_wait_seconds` | 4, 6, 30 | view requests (reads, coverage, signal tracks) computed at once |
| `global_rate_per_second` | 400 | all requests that passed their client's limits, together |
| `max_body_kb` | 1024 | request body size; uploads (multipart/form bodies) are always refused |
| `max_span_bp`, `max_coverage_span_bp` | 1 Mb, 300 Mb | every window a request names (`start`/`end`, any `<name>_start`/`<name>_end` pair such as a contact-map selection's `x_`/`y_`, a region string), and zoomed-out views (coverage, genes, signal tracks, binned contact matrices) |
| `max_reads`, `max_bins`, `max_clusters`, `max_regions` | 2000, 10000, 50, 50 | read counts, bins, k, and region lists in a request |
| `max_profile_window`, `max_vplot_cells` | 5000, 1,000,000 | footprint profile window and flank (bp each side), and V-plot size (size bins × position bins, from the values the route will use, defaults included; only when a V-plot is made; a cluster V-plot counts all its per-cluster matrices, with at most `max_clusters` clusters per dataset); also checked where the matrices are allocated |
| `max_working_reads` | 20,000 | reads per view (`--max-working-reads`) |
| `consensus_region_bp`, `consensus_cores`, `consensus_queue` | 50 kb, ≤2, 3 | footprint-class runs (the compute settings are the server's, not the visitor's) |
| `session_max_tracks`, `session_max_consensus_runs` | 40, 4 | tracks and stored footprint-class runs per visitor |
| `sessions_per_ip` | 24 | sessions one address holds. At the cap, only that address's own idle sessions are dropped; if none is idle, it gets 429. |
| `session_cache_entries`, `idle_cache_seconds` | 2, 120 | read caches per visitor, emptied after this much idle time |
| `memory_mb` | 0 (off) | resident memory above which idle caches are dropped and new visitors wait (503) |
| `cache_mb`, `cache_ttl_seconds` | 256, 300 | the shared cache of identical view responses (0 turns it off) |

Other settings:

- `--trusted-proxy IP_OR_CIDR` (repeatable), a config file's
  `auth.trusted_proxies`, or `FIBERBROWSER_TRUSTED_PROXIES`: the reverse
  proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed. It is
  one list for every profile; a lab server's sign-in proxy uses it too.
  Without it, the connecting address is the client.
- `FIBERBROWSER_ALLOWED_HOSTS`: the host names the server answers to.
- `FIBERBROWSER_MAX_SESSIONS`: sessions per process, 200 by default. Visitors
  idle for 30 minutes are dropped.
- `FIBERBROWSER_CORS_ORIGINS`: leave it unset. The page and its API share one
  origin.

All limits apply per process. With several replicas, a client that sends no
cookies can be spread over all of them.

A lab server's anonymous catalog visitors (`[public_catalog]`) get the
public route allowlist, path redaction and read-window limits, but not the
rate limits, analysis slots or shared cache on this page: those belong to
`profile = "public"`. Publish anonymously with a public server.

## Security design

What each part of an anonymous request goes through:

| Threat | What stops it |
|---|---|
| Server files, processes, credentials | Only allowlisted routes reach a public server (`public_mode_guard.PUBLIC_ALLOWED`; a new route stays closed until it is classified, and a test enforces this). Routes that take a path, start a process or read the host's settings are not on the list. |
| SSRF | No route a visitor can reach takes a URL or path that the server opens or fetches. Add-track by URL and the external track search are refused. The catalog is the host's. A test feeds URLs (https, s3, the cloud metadata address, file://) to every public route and checks that nothing is resolved, opened or fetched. |
| Session links (only with `FIBERBROWSER_LINK_HOSTS`) | Off unless the operator lists link hosts. Nothing is fetched until the visitor confirms; then documents, hub files and every file a link opens are read over https from listed host names only, resolved once per request, checked against private and reserved addresses, connected to the checked address, with every redirect re-checked. BAM/bigWig/bigBed readers get a loopback relay (a small helper process, `python -m services.link_proxy`) that applies these rules, never the URL itself. See [Open data from a link](../workflows/open-from-links.md#6-security-model). |
| Uploads | Every multipart or form body gets 415; the upload route is not on the allowlist. |
| Request floods | Token buckets per client address, stricter ones for analyses, and a server-wide backstop. A limited client doesn't use up the shared budget. |
| Expensive analyses | Per-request limits: region span, read counts, k, bins and list lengths, in the query string and in JSON bodies. Analyses run in slots, per client and server-wide. Footprint-class runs use the server's compute settings. A long analysis gets 503 but keeps its slot until it really ends. |
| One visitor slowing everyone | API work runs on worker threads' own event loops, so an analysis written as blocking code can't freeze the server. View requests are computed a few at a time. |
| Session exhaustion | Sessions per address are capped, and at the cap only that address's own idle sessions are dropped. The server-wide cap drops only idle sessions. When full, the server answers 503 with `Retry-After`. Session IDs are only ever minted by the server. |
| Memory exhaustion | Per-visitor read caches are small and emptied after idle time. The memory guard stops admitting new visitors. The container has a memory limit. |
| Slow clients, huge bodies | Caddy in front (timeouts, a 4 MB body limit). The app also checks body size, including chunked bodies. |
| Spoofed client address | `X-Forwarded-For` and `-Proto` count only from `--trusted-proxy`. uvicorn's own header rewrite is off on public servers. |
| Information leaks | Responses show file names, not server paths. A 500 becomes a generic message with a request ID. Other error bodies have paths and tracebacks removed. `/docs` and `/openapi.json` don't exist. |
| Cached answers leaking between visitors | The shared cache is keyed by a fingerprint of the visitor's whole session (datasets, filters, settings, tracks, runs). A response is stored only if no change happened while it was computed. Tests check that visitors with different settings never share an answer. |
| XSS, clickjacking, other websites | A Content-Security-Policy on the page: scripts from this origin only, inline scripts by per-response nonce, `frame-ancestors 'none'`, `object-src 'none'`. Also `X-Frame-Options: DENY`, `nosniff`, a same-origin referrer policy and COOP. HSTS is sent over HTTPS. Requests other websites send are refused (Origin/Sec-Fetch checks); CORS is off. |
| Stale or poisoned static files | Only content-hashed asset names are cached as `immutable`. The page itself is `no-cache`. |

## Load testing your server

Run the load test against your own server only. Start it with
`--trusted-proxy 127.0.0.1` (or run the test from the Caddy host) so that
each simulated visitor counts as its own address:

```bash
python scripts/load_test_public.py --base-url http://127.0.0.1:8000 \
    --viewers 60 --duration 90 --server-pid <pid[,pid,...]> --json results.json
```

The first phase runs visitors alone; the second adds the abusive clients.
For each phase it reports:

- latency percentiles per request class;
- status counts, shared-cache hits, and the server's memory and CPU;
- how the visitors' 95th percentiles changed once the abusers joined.

`--center`/`--chrom` set the locus the simulated visitors open (default: the
demo's NAPA promoter).
