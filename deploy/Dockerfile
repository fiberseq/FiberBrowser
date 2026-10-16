# FiberBrowser public server image (--public). Build from the repository root:
#   docker build -f deploy/Dockerfile -t fiberbrowser .
# Released images: ghcr.io/fiberseq/fiberbrowser:<version> (release-docker.yml).
#
# The image installs FiberBrowser as its pip package (the wheel carries the
# committed frontend build; no Node needed), with FiberHMM 3 from PyPI. Wheels
# placed in deploy/wheels/ are preferred over PyPI, e.g. a local FiberHMM build:
#   pip wheel --no-deps -w deploy/wheels /path/to/FiberHMM

FROM python:3.11-slim AS wheel
WORKDIR /src
RUN pip install --no-cache-dir "hatchling>=1.24" build
COPY . .
RUN python -m build --wheel --no-isolation --outdir /wheels .

FROM python:3.11-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcurl4 zlib1g libbz2-1.0 liblzma5 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=wheel /wheels/ /tmp/wheels/
COPY deploy/wheels/ /tmp/wheels/local/
RUN pip install --no-cache-dir --find-links /tmp/wheels/local /tmp/wheels/fiberbrowser-*.whl \
 && rm -rf /tmp/wheels
# The package's commands: `fiberbrowser serve --config ...` (the lab server,
# deploy/lab/) and `python -m fiberbrowser users|audit|check-config`.

# The demo catalog (the tracked NAPA demo BAM), for trying the image out:
#   docker run --rm -p 127.0.0.1:8000:8000 fiberbrowser --catalog /opt/fiberbrowser-demo/deploy/demo/catalog.json
COPY deploy/demo/catalog.json /opt/fiberbrowser-demo/deploy/demo/catalog.json
COPY browser/data/demo/napa_ddda.bam browser/data/demo/napa_ddda.bam.bai /opt/fiberbrowser-demo/browser/data/demo/

# Non-root; genome downloads and caches go to /home/fiberbrowser/.fiberhmm
# (mount a volume there to keep them across restarts).
RUN useradd --create-home --uid 10001 fiberbrowser
USER fiberbrowser
ENV HOME=/home/fiberbrowser PYTHONUNBUFFERED=1 FIBERBROWSER_NO_OPEN=1 FIBERHMM_NO_UPDATE_CHECK=1
# htslib keeps the index of a remote (https/s3) BAM in the working directory:
# a writable one (the container's /tmp is a tmpfs in docker-compose.yml).
WORKDIR /tmp

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"
# --public: route allowlist, per-visitor sessions, rate limits (see
# docs/deployment/public-server.md). Mount the data folder read-only at /data
# with catalog.json at its top: the catalog's relative paths resolve there.
ENTRYPOINT ["fiberbrowser", "--public", "--host", "0.0.0.0", "--port", "8000", "--no-open-browser", "--copilot", "off"]
CMD ["--catalog", "/data/catalog.json"]
