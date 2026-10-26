#!/usr/bin/env python
"""Start FiberBrowser with every pangenome feature turned on, and load demo data.

Turns on, for this server only:
  * live lift (on by default; FIBERBROWSER_LIVE_LIFT=1 is set too, for builds where it was opt-in): lifted
    datasets, linked source views, the Differences row's assembly lanes;
  * the graph helper and a graph package (graph mode on dataset panels, the graph view panel);
  * preview features (Settings > Show preview features), which include the standalone graph view panel.

Then it adds each sample: the BAM aligned to the sample's own assembly as a live-lift dataset ("Sample A
(lifted)"), and optionally the same reads aligned to the reference as a native dataset ("Sample A (GRCh38)").

    python scripts/unified_demo.py                         # the defaults below, on port 8883
    python scripts/unified_demo.py --port 8890 --build     # build this checkout's frontend first
    python scripts/unified_demo.py \\
        --sample "Sample A" ~/data/a.hg002v1.1.bam ~/data/a.GRCh38.bam \\
        --sample "Sample B" ~/data/b.hg002v1.1.bam \\
        --map ~/maps/hprc.GRCh38.HG002.chain.graphlift.json \\
        --graph-package ~/graphs/hprc-package --fasta ~/ref/GRCh38.fa

Defaults live under one work folder, $PGLIFT_WORK or ~/pglift_work:
  demo_data/sample_a.alu_chr3.hg002v1.1.bam   reads aligned to the sample's assembly (lifted)
  demo_data/sample_a.alu_chr3.GRCh38.bam      the same reads aligned to GRCh38 (native)
  maps/hprc.GRCh38.HG002.chain.graphlift.json the graphlift map (a sidecar manifest and its files)
  graph/hprc-package/                          a graph package (made with `fiberbrowser-graph prepare`)
  ref/GRCh38.fa                                the reference FASTA (with its .fai)

The graph helper is taken from --graph-helper, else from the `fiberbrowser[graph]` companion package
(or the macOS app). The server gets its own HOME (a new temporary folder unless --home is given), so
your ~/.fiberhmm settings, Library and sessions are never read or changed. It listens on localhost
without an access token: a demo for this computer only. Ctrl+C stops it.
"""
import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.expanduser(os.environ.get("PGLIFT_WORK", "~/pglift_work"))
DEFAULT_VIEW = "chr3:128,653,000-128,661,000"   # the AluY insertion of the demo data


def work(*parts: str) -> str:
    return os.path.join(WORK, *parts)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8883)
    ap.add_argument("--sample", nargs="+", action="append", metavar=("LABEL", "BAM"),
                    help="LABEL LIFTED_BAM [NATIVE_BAM]: a sample's reads on its own assembly (added as a live-lift "
                         "dataset, 'LABEL (lifted)') and, optionally, on the reference ('LABEL (GRCh38)'). "
                         "Repeat for more samples. Default: Sample A from demo_data/.")
    ap.add_argument("--map", default=work("maps", "hprc.GRCh38.HG002.chain.graphlift.json"),
                    help="graphlift map (.graphlift.json) for the lifted BAMs")
    ap.add_argument("--graph-package", action="append", default=None, metavar="DIR",
                    help="graph package folder (repeatable; default: graph/hprc-package)")
    ap.add_argument("--no-graph", action="store_true",
                    help="no graph package: lifted datasets open as one panel per haplotype")
    ap.add_argument("--graph-helper", default=None, metavar="PATH",
                    help="fiberbrowser-graph executable (default: the fiberbrowser[graph] companion package)")
    ap.add_argument("--fasta", default=work("ref", "GRCh38.fa"), help="reference FASTA (with .fai)")
    ap.add_argument("--native-label", default="GRCh38", help="suffix of native dataset labels (default: GRCh38)")
    ap.add_argument("--pooled", action="store_true", help="lifted datasets as one pooled panel (not graph or split)")
    ap.add_argument("--no-preview", action="store_true", help="leave preview features off")
    ap.add_argument("--view", default=DEFAULT_VIEW, help=f"locus to print in the start link (default {DEFAULT_VIEW})")
    ap.add_argument("--home", default=None, help="the server's HOME (default: a new temporary folder)")
    ap.add_argument("--python", default=sys.executable, help="Python that runs the server (default: this one)")
    ap.add_argument("--build", action="store_true",
                    help="build this checkout's frontend into <home>/frontend-dist first (never into the checkout)")
    ap.add_argument("--frontend-dist", default=None,
                    help="frontend build to serve (default with --build: <home>/frontend-dist, else the checkout's)")
    a = ap.parse_args(argv)
    if not a.sample:
        a.sample = [["Sample A", work("demo_data", "sample_a.alu_chr3.hg002v1.1.bam"),
                     work("demo_data", "sample_a.alu_chr3.GRCh38.bam")]]
    for s in a.sample:
        if len(s) not in (2, 3):
            ap.error("--sample takes LABEL LIFTED_BAM [NATIVE_BAM]")
    if a.graph_package is None and not a.no_graph:
        a.graph_package = [work("graph", "hprc-package")]
    return a


def full(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))


def check_inputs(a) -> None:
    missing = []
    a.map = full(a.map)
    if not os.path.exists(a.map):
        missing.append(f"lift map: {a.map}")
    for s in a.sample:
        s[1:] = [full(p) for p in s[1:]]
        missing += [f"{s[0]} BAM: {p}" for p in s[1:] if not os.path.exists(p)]
    if not a.no_graph:
        a.graph_package = [full(p) for p in a.graph_package]
        missing += [f"graph package: {p}" for p in a.graph_package if not os.path.isdir(p)]
        if a.graph_helper:
            a.graph_helper = full(a.graph_helper)
            if not os.access(a.graph_helper, os.X_OK):
                missing.append(f"graph helper: {a.graph_helper}")
    a.fasta = full(a.fasta)
    if missing:
        sys.exit("Missing inputs (see --help for the defaults):\n  " + "\n  ".join(missing))
    if not os.path.exists(a.fasta):
        print(f"No reference FASTA at {a.fasta}: the sequence track and assembly bases stay off.", flush=True)


def server_env(a) -> dict:
    scratch = os.path.join(a.home, "scratch")
    os.makedirs(scratch, exist_ok=True)
    prefs = os.path.join(scratch, "analysis_preferences.json")
    with open(prefs, "w") as fh:
        json.dump({"show_preview_features": not a.no_preview}, fh)
    env = dict(os.environ)
    env.update({
        "HOME": a.home,
        "FIBERBROWSER_LIVE_LIFT": "1",
        "FIBERBROWSER_PREFERENCES": prefs,
        "FIBERBROWSER_GRAPH_REGISTRY": os.path.join(scratch, "graph_registrations.json"),
        "FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN": "1",
        "FIBERBROWSER_NO_UPDATE_CHECK": "1",
        "FIBERBROWSER_NO_OPEN": "1",
        "FIBERBROWSER_PORT_MIN": str(a.port),
        "FIBERBROWSER_PORT_MAX": str(a.port),
        "NUMBA_CACHE_DIR": os.path.join(scratch, "numba"),
        "PYTHONUNBUFFERED": "1",
    })
    if not a.no_graph:
        env["FIBERBROWSER_GRAPH_PACKAGES"] = os.pathsep.join(a.graph_package)
        if a.graph_helper:
            env["FIBERBROWSER_GRAPH_HELPER"] = a.graph_helper
    else:
        env.pop("FIBERBROWSER_GRAPH_PACKAGES", None)
    if a.frontend_dist:
        env["FIBERBROWSER_FRONTEND_DIST"] = a.frontend_dist
    return env


def wait_ready(port: int, proc, timeout: float = 180.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit("FiberBrowser exited before it was ready (see its output above).")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)
    sys.exit("FiberBrowser did not become ready in time.")


def post(port: int, path: str, body: dict) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"success": False, "error": str(e)}


def add_samples(a) -> None:
    settings = {"haplotype_mode": "pooled" if a.pooled else "split"}
    for s in a.sample:
        label, lifted, native = s[0], s[1], (s[2] if len(s) > 2 else None)
        out = post(a.port, "/api/lift/datasets", {"paths": [lifted], "manifest": a.map, "haplotypes": [],
                                                  "label": f"{label} (lifted)", "settings": settings})
        if not out.get("success"):
            sys.exit(f"Could not add {label} as a live-lift dataset: {out.get('error')}")
        print(f"Added {label} (lifted)", flush=True)
        if native:
            out = post(a.port, "/api/datasets/add", {"path": native, "label": f"{label} ({a.native_label})"})
            if not out.get("success"):
                sys.exit(f"Could not add {label} ({a.native_label}): {out.get('error')}")
            print(f"Added {label} ({a.native_label})", flush=True)


def main(argv=None):
    a = parse_args(argv)
    check_inputs(a)
    a.home = full(a.home) if a.home else tempfile.mkdtemp(prefix="fiberbrowser-unified-")
    os.makedirs(a.home, exist_ok=True)
    if a.build and not a.frontend_dist:
        a.frontend_dist = os.path.join(a.home, "frontend-dist")
    if a.frontend_dist:
        a.frontend_dist = full(a.frontend_dist)
    if a.build:
        subprocess.run(["npx", "vite", "build", "--outDir", a.frontend_dist, "--emptyOutDir"],
                       cwd=os.path.join(ROOT, "browser", "frontend"), check=True)
    args = [a.python, "browser.py", "-p", str(a.port), "--no-open", "--no-token", "--copilot", "off"]
    if os.path.exists(a.fasta):
        args += ["--fasta", a.fasta]
    print("Server: " + shlex.join(args), flush=True)
    proc = subprocess.Popen(args, cwd=ROOT, env=server_env(a))
    try:
        wait_ready(a.port, proc)
        add_samples(a)
        chrom, span = a.view.replace(",", "").split(":")
        start, end = span.split("-")
        print(f"\nReady: http://localhost:{a.port}/?chr={chrom}&start={start}&end={end}")
        print(f"Server HOME: {a.home} (pid {proc.pid}). Ctrl+C stops it.\n", flush=True)
        proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
