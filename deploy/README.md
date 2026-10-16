# Deploying a public FiberBrowser server

The full guide: [docs/deployment/public-server.md](../docs/deployment/public-server.md).
It covers the catalog, BigBed and remote data, Docker Compose, systemd,
firewall, logs, updates, monitoring, sizing, every limit, and the security
design.

What is here:

| File | What it is |
|---|---|
| `Dockerfile` | The `--public` server image, built from the pip package (`ghcr.io/fiberseq/fiberbrowser:<version>` on each release). Wheels in `wheels/` are preferred over PyPI. |
| `docker-compose.yml` | FiberBrowser replicas behind Caddy (automatic HTTPS, sticky sessions, health checks, log rotation). Settings come from `deploy/.env`. |
| `Caddyfile` | Caddy's site: HTTPS, compression, sticky load balancing over the replicas, and an optional reviewer password (commented out). |
| `systemd/fiberbrowser@.service` | The no-Docker alternative: one process per port, behind Caddy on the same machine. |
| `demo/catalog.json` | A working catalog with the demo BAM, for trying things out. |

Quick start (a Linux VM with Docker, a DNS name, ports 80/443 open):

```bash
cat > deploy/.env <<'ENV'
FIBERBROWSER_DOMAIN=browser.example.org
FIBERBROWSER_DATA=/srv/fiberbrowser-data   # catalog.json + the files it lists
ENV
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

To load-test a server of your own, use `scripts/load_test_public.py`.
