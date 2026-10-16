# The FiberBrowser WSL distribution's root filesystem (linux/amd64).
# Built by build_wsl_distro.sh, which exports a container of this image as the
# tarball that `wsl --import FiberBrowser <dir> <tarball>` takes. Not a server
# image: nothing here runs as a container entrypoint.
#
# Build context (prepared by build_wsl_distro.sh):
#   wheels/      fiberbrowser-*.whl and fiberhmm-*.whl
#   rootfs/      files copied over / (wsl.conf, the fiberbrowser-wsl-serve entry)
#   minimap2-<version>.tar.bz2
#   licenses/      third-party notices (THIRD_PARTY_NOTICES.txt)
#   build.json     the build's flavour, version and update channel (packaging/write_build_info.py)
#   te_libraries/  the bundled TE library's files (packaging/third_party.sh)
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

FROM ${PYTHON_IMAGE} AS build
ARG MINIMAP2_VERSION
ARG MINIMAP2_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential zlib1g-dev bzip2 libcurl4-openssl-dev \
 && rm -rf /var/lib/apt/lists/*
# minimap2 (MIT): the same release the Mac app bundles, built from source.
COPY minimap2-${MINIMAP2_VERSION}.tar.bz2 /tmp/
RUN cd /tmp \
 && echo "${MINIMAP2_SHA256}  minimap2-${MINIMAP2_VERSION}.tar.bz2" | sha256sum -c - \
 && tar -xjf minimap2-${MINIMAP2_VERSION}.tar.bz2 \
 && make -s -C minimap2-${MINIMAP2_VERSION} -j4 \
 && install -m 755 minimap2-${MINIMAP2_VERSION}/minimap2 /usr/local/bin/minimap2 \
 && install -D -m 644 minimap2-${MINIMAP2_VERSION}/LICENSE.txt /usr/local/share/licenses/minimap2/LICENSE.txt
COPY licenses/ /usr/local/share/licenses/
# FiberBrowser + FiberHMM and the extras the Mac app ships: primer design,
# contact maps (+ s3:// matrices) and UMAP. The Copilot (MLX, Apple silicon
# only) is not included; the launcher starts the server with --no-copilot.
# Binary wheels where they exist (--prefer-binary keeps pip from picking an
# old release only because it has a wheel); the few pure-Python packages
# published as source only are built here. pyBigWig is built from source
# against libcurl: PyPI's x86_64 Linux wheel has no libcurl (pyBigWig.remote
# == 0), so it can't read any http(s), s3:// or ssh:// bigWig/bigBed.
COPY wheels/ /tmp/wheels/
RUN python -m venv /opt/fiberbrowser \
 && /opt/fiberbrowser/bin/pip install --no-cache-dir --disable-pip-version-check -q --upgrade pip \
 && /opt/fiberbrowser/bin/pip install --no-cache-dir --disable-pip-version-check -q --prefer-binary \
      --find-links /tmp/wheels --no-binary pyBigWig \
      /tmp/wheels/fiberhmm-*.whl \
      "$(ls /tmp/wheels/fiberbrowser-*.whl)[primers,contact-maps,s3,umap]" \
      # A current s3fs: left free, pip settles a new boto3 by taking s3fs 0.4 (2020).
      "s3fs>=2024.1" \
 && /opt/fiberbrowser/bin/pip list --format=freeze > /opt/fiberbrowser/packages.txt \
 # Lean: test suites, byte code (rebuilt under ~/.cache on first use) and C headers.
 && find /opt/fiberbrowser -depth -type d \( -name __pycache__ -o -name tests -o -name test \) \
      -path '*/site-packages/*' -not -path '*/fiberbrowser/*' -not -path '*/fiberhmm/*' -exec rm -rf {} + \
 && find /opt/fiberbrowser -depth -type d -name __pycache__ -exec rm -rf {} + \
 && find /opt/fiberbrowser -type d -name include -path '*/site-packages/*' -prune -exec rm -rf {} +
RUN /opt/fiberbrowser/bin/python -c "import fiberbrowser, fiberhmm, pysam, pyBigWig, numba, primer3, cooler, umap, s3fs; \
assert pyBigWig.remote and pyBigWig.numpy, 'pyBigWig was built without libcurl or numpy'; \
print('FiberBrowser', fiberbrowser.__version__, 'FiberHMM', fiberhmm.__version__)"

FROM ${PYTHON_IMAGE}
# ca-certificates: genome / track downloads over https; openssh-client: cluster
# sources (ssh://); libcurl4: pyBigWig's remote tracks; procps: ps/pkill for the launcher's fallback stop; libgomp1:
# BLAST+ (OpenMP). BLAST+ is Debian's ncbi-blast+ (bookworm: 2.12.0; its libraries are
# linked dynamically from their own packages, each with its copyright file; no LZO);
# only blastn and makeblastdb are kept (/usr/bin). Sources: sources.debian.org / snapshot.debian.org.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssh-client libcurl4 procps libgomp1 ncbi-blast+ \
 && for f in $(dpkg -L ncbi-blast+ | grep '^/usr/bin/'); do \
      case "$(basename "$f")" in blastn|makeblastdb) ;; *) rm -f "$f" ;; esac; done \
 && blastn -version && makeblastdb -version \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/man/* /usr/share/info/* \
 # Every package's copyright file stays (the licence notices the image must carry); the rest of its docs go.
 && find /usr/share/doc -mindepth 1 -type f ! -name copyright -delete \
 && find /usr/share/doc -mindepth 1 -depth -type d -empty -delete
COPY --from=build /opt/fiberbrowser /opt/fiberbrowser
COPY --from=build /usr/local/bin/minimap2 /usr/local/bin/
COPY --from=build /usr/local/share/licenses /usr/local/share/licenses
# The D. melanogaster TE library's source files (read-only; services/te_library.py bundled_library_dir):
# Identify sets the library up from them under ~/.fiberhmm/te_libraries, no download.
COPY te_libraries/ /opt/fiberbrowser/share/fiberbrowser/te_libraries/
RUN BLAST_USAGE_REPORT=false blastn -version && BLAST_USAGE_REPORT=false makeblastdb -version
# The build information (services/app_build.py): a packaged app, which runs its bundled FiberHMM by default.
COPY build.json /opt/fiberbrowser/share/fiberbrowser/build.json
COPY rootfs/ /
# The user FiberBrowser runs as (uid 1000, as WSL's own distributions use);
# /etc/wsl.conf makes it the default. Its home holds ~/.fiberhmm (settings,
# sessions, the Library, downloaded genomes), which the Windows installer
# backs up across upgrades and uninstalls.
RUN useradd --create-home --uid 1000 --shell /bin/bash fiberbrowser \
 && chmod 755 /usr/local/bin/fiberbrowser-wsl-serve \
 && ln -sf /opt/fiberbrowser/bin/fiberbrowser /usr/local/bin/fiberbrowser \
 && for cmd in /opt/fiberbrowser/bin/fiberhmm-*; do ln -sf "$cmd" "/usr/local/bin/$(basename "$cmd")"; done \
 && mkdir -p /home/fiberbrowser/data && chown fiberbrowser:fiberbrowser /home/fiberbrowser/data \
 && rm -f /etc/hostname
