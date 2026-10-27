#!/usr/bin/env python
"""Start FiberBrowser with every pangenome feature turned on, and load demo data.

Turns on, for this server only:
  * live lift (FIBERBROWSER_LIVE_LIFT=1; it is on by default, except on lab and public servers): lifted
    datasets, linked source views, the Differences row's assembly lanes;
  * the graph helper and a graph package (graph mode on dataset panels, the graph view panel);
  * preview features (Settings > Show preview features), which include the standalone graph view panel.

Then it adds each sample: the BAM aligned to the sample's own assembly as a live-lift dataset ("Sample A
(lifted)"), and optionally the same reads aligned to the reference as a native dataset ("Sample A (GRCh38)").

    python scripts/unified_demo.py                         # the defaults below, on port 8883
    python scripts/unified_demo.py --port 8890 --build     # build this checkout's frontend first
    python scripts/unified_demo.py --locus mhc --port 8891 # the MHC window instead: "Not a carrier" on the graph
    python scripts/unified_demo.py \\
        --sample "Sample A" ~/data/a.hg002v1.1.bam ~/data/a.GRCh38.bam \\
        --sample "Sample B" ~/data/b.hg002v1.1.bam \\
        --map ~/maps/hprc.GRCh38.HG002.chain.graphlift.json \\
        --graph-package ~/graphs/hprc-package --fasta ~/ref/GRCh38.fa

Defaults live under one work folder, $PGLIFT_WORK or ~/pglift_work:
  demo_data/sample_a.alu_chr3.hg002v1.1.bam   reads aligned to the sample's assembly (lifted)
  demo_data/sample_a.alu_chr3.GRCh38.bam      the same reads aligned to GRCh38 (native)
  demo_data/sample_a.mhc.hg002v1.1.bam        --locus mhc: an MHC slice of the same sample (lifted)
  demo_data/sample_a.mhc.GRCh38.bam           --locus mhc: the same reads aligned to GRCh38 (native)
  demo_data/sample_a.mhc.not_carrier_region.bed  --locus mhc: a region inside the paternal-only deletion (peak BED)
  maps/hprc.GRCh38.HG002.chain.graphlift.json the lift map (a graphlift sidecar and its files, or a UCSC .chain)
  graph/hprc-package/                          a graph package (made with `fiberbrowser-graph prepare`)
  ref/GRCh38.fa                                the reference FASTA (with its .fai)
  ref/source.fa(.gz)                           optional: the samples' own assembly FASTA (indexed)

The graph helper is taken from --graph-helper, else from $FIBERBROWSER_GRAPH_HELPER, else from a
`fiberbrowser-graph` on your PATH, else from the `fiberbrowser[graph]` companion package (or the macOS app). The server gets its own HOME (a new temporary folder unless --home is given), so
your ~/.fiberhmm settings, Library and sessions are never read or changed. It listens on localhost
without an access token: a demo for this computer only. Ctrl+C stops it.
"""
import argparse
import json
import os
import shlex
import shutil
import socket
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.expanduser(os.environ.get("PGLIFT_WORK", "~/pglift_work"))
# Demo loci (--locus): each one's sample BAMs under demo_data/ (lifted, native), the view its start link opens and,
# for one with a guided step, a note printed under the link.
LOCI = {
    # The AluY insertion, which both haplotypes carry.
    "alu": {"bams": ("sample_a.alu_chr3.hg002v1.1.bam", "sample_a.alu_chr3.GRCh38.bam"),
            "view": "chr3:128,653,000-128,661,000"},
    # GRCh38 chr6:31,045,089-31,045,177 (89 bp) is missing from HG002's paternal haplotype only, and the maternal one
    # carries it: graph clustering at a region inside it labels the paternal reads "Not a carrier". (The map proves a
    # deletion absent only below 200 bp, and a Scan peak here reaches past its ends, so the region is imported or drawn.)
    "mhc": {"bams": ("sample_a.mhc.hg002v1.1.bam", "sample_a.mhc.GRCh38.bam"),
            "view": "chr6:31,044,530-31,045,730",
            "note": "Not a carrier: HG002's paternal haplotype lacks GRCh38 chr6:31,045,089-31,045,177 (89 bp); the "
                    "maternal one carries it.",
            "region": "chr6:31,045,099-31,045,167", "region_bed": "sample_a.mhc.not_carrier_region.bed"},
}
DEFAULT_VIEW = LOCI["alu"]["view"]


def work(*parts: str) -> str:
    return os.path.join(WORK, *parts)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8883)
    ap.add_argument("--locus", choices=sorted(LOCI), default="alu",
                    help="demo locus: its samples (from demo_data/) and start view, unless --sample / --view are given. "
                         "alu: the AluY insertion (default); mhc: a paternal-only deletion, for 'Not a carrier'")
    ap.add_argument("--sample", nargs="+", action="append", metavar=("LABEL", "BAM"),
                    help="LABEL LIFTED_BAM [NATIVE_BAM]: a sample's reads on its own assembly (added as a live-lift "
                         "dataset, 'LABEL (lifted)') and, optionally, on the reference ('LABEL (GRCh38)'). "
                         "Repeat for more samples. Default: Sample A from demo_data/ at the --locus.")
    ap.add_argument("--map", default=work("maps", "hprc.GRCh38.HG002.chain.graphlift.json"),
                    help="lift map for the lifted BAMs: a graphlift .graphlift.json, or a UCSC .chain / .chain.gz")
    ap.add_argument("--graph-package", action="append", default=None, metavar="DIR",
                    help="graph package folder (repeatable; default: graph/hprc-package)")
    ap.add_argument("--no-graph", action="store_true",
                    help="no graph package: lifted datasets open as one panel per haplotype")
    ap.add_argument("--graph-helper", default=None, metavar="PATH",
                    help="fiberbrowser-graph executable (default: $FIBERBROWSER_GRAPH_HELPER, else fiberbrowser-graph "
                         "on PATH, else the fiberbrowser[graph] companion package)")
    ap.add_argument("--fasta", default=work("ref", "GRCh38.fa"), help="reference FASTA (with .fai)")
    ap.add_argument("--source-fasta", default=None, metavar="FILE",
                    help="the samples' own assembly FASTA (indexed; optional): assembly bases in the inspector, Identify on "
                         "assembly insertions, 'Confirmed by assembly' for insertions (default: ref/source.fa or "
                         "ref/source.fa.gz if present)")
    ap.add_argument("--native-label", default="GRCh38", help="suffix of native dataset labels (default: GRCh38)")
    ap.add_argument("--pooled", action="store_true", help="lifted datasets as one pooled panel (not graph or split)")
    ap.add_argument("--no-preview", action="store_true", help="turn preview features off for this server")
    ap.add_argument("--view", default=None,
                    help=f"locus to print in the start link (default: the --locus's view, {DEFAULT_VIEW} for alu)")
    ap.add_argument("--home", default=None, help="the server's HOME (default: a new temporary folder)")
    ap.add_argument("--python", default=sys.executable, help="Python that runs the server (default: this one)")
    ap.add_argument("--build", action="store_true",
                    help="build this checkout's frontend into <home>/frontend-dist first (never into the checkout)")
    ap.add_argument("--frontend-dist", default=None,
                    help="frontend build to serve (default with --build: <home>/frontend-dist, else the checkout's)")
    a = ap.parse_args(argv)
    locus = LOCI[a.locus]
    # The locus's note is about its own demo data: printed only when those samples are loaded.
    a.locus_note = None
    if not a.sample:
        a.sample = [["Sample A", *(work("demo_data", name) for name in locus["bams"])]]
        a.locus_note = locus_note(a.locus)
    if a.view is None:
        a.view = locus["view"]
    for s in a.sample:
        if len(s) not in (2, 3):
            ap.error("--sample takes LABEL LIFTED_BAM [NATIVE_BAM]")
    if a.graph_package is None and not a.no_graph:
        a.graph_package = [work("graph", "hprc-package")]
    return a


def locus_note(name: str):
    """The note printed under a locus's start link (None: none): its region, and its region BED when it is there."""
    locus = LOCI[name]
    if not locus.get("note"):
        return None
    lines = [locus["note"]]
    if locus.get("region"):
        draw = "Option-drag (Alt-drag) within the deletion on the graph"
        bed = work("demo_data", locus["region_bed"]) if locus.get("region_bed") else ""
        how = (f"import {bed}\n  (Rules > Peaks > Presets > Import peaks from BED...), or {draw}" if bed and os.path.exists(bed)
               else draw)
        lines += [f"  Cluster on the graph at a region inside it ({locus['region']}): {how}.",
                  f"  Select no other region on {locus['region'].split(':')[0]}, then click Cluster."]
    return "\n".join(lines)


def full(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))


def find_graph_helper(explicit=None, environ=None, which=shutil.which):
    """The graph helper to hand the server, and where it came from: --graph-helper, else $FIBERBROWSER_GRAPH_HELPER,
    else `fiberbrowser-graph` on PATH. (None, None) leaves the server to its own search (the companion package, the
    macOS app). The server's environment keeps no inherited FIBERBROWSER_* variable, so the one found is passed on."""
    if explicit:
        return full(explicit), "--graph-helper"
    env = os.environ if environ is None else environ
    from_env = (env.get("FIBERBROWSER_GRAPH_HELPER") or "").strip()
    if from_env:
        return full(from_env), "FIBERBROWSER_GRAPH_HELPER"
    on_path = which("fiberbrowser-graph", path=env.get("PATH"))
    if on_path:
        return full(on_path), "PATH"
    return None, None


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
        a.graph_helper, a.graph_helper_source = find_graph_helper(a.graph_helper)
        if a.graph_helper and not os.access(a.graph_helper, os.X_OK):
            missing.append(f"graph helper ({a.graph_helper_source}): {a.graph_helper}")
    a.fasta = full(a.fasta)
    if a.source_fasta:
        a.source_fasta = full(a.source_fasta)
        if not os.path.exists(a.source_fasta):
            missing.append(f"source assembly FASTA: {a.source_fasta}")
    else:
        a.source_fasta = next((work("ref", n) for n in ("source.fa", "source.fa.gz") if os.path.exists(work("ref", n))), None)
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
    # Inherited FIBERBROWSER_* settings (a Library, settings file or server config of your own) are dropped, and every
    # store the server writes points into the demo's home: the demo never reads or changes your own files.
    env = {k: v for k, v in os.environ.items() if not k.startswith("FIBERBROWSER_")}
    env.update({
        "HOME": a.home,
        "FIBERBROWSER_LIVE_LIFT": "1",
        "FIBERBROWSER_PREFERENCES": prefs,
        "FIBERBROWSER_GRAPH_REGISTRY": os.path.join(scratch, "graph_registrations.json"),
        "FIBERBROWSER_SETTINGS": os.path.join(scratch, "browser_settings.json"),
        "FIBERBROWSER_APP_SETTINGS": os.path.join(scratch, "app_settings.json"),
        "FIBERBROWSER_RUNTIME_FILE": os.path.join(scratch, "browser_runtime.json"),
        "FIBERBROWSER_LIBRARY": os.path.join(scratch, "library.json"),
        "FIBERBROWSER_JOBS_DIR": os.path.join(scratch, "jobs"),
        "FIBERBROWSER_QC_CACHE_DIR": os.path.join(scratch, "qc_cache"),
        "FIBERBROWSER_UPLOAD_DIR": os.path.join(scratch, "uploads"),
        "FIBERBROWSER_REGION_CATALOG_DIR": os.path.join(scratch, "regions"),
        "FIBERBROWSER_RECENT_TRACKS_FILE": os.path.join(scratch, "recent_tracks.json"),
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


def warm_graph(port: int) -> None:
    """Load the graph helper and check the packages now: the first status request does it, and on a cold start that
    can take a minute, during which a page already open shows lifted datasets split rather than as graphs. Says
    plainly when graph mode is unavailable."""
    print("Checking the graph helper and packages (up to a minute on a cold start)...", flush=True)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/graph/status", timeout=600) as r:
            status = json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"Could not check graph mode: {e}", flush=True)
        return
    helper = status.get("helper") or {}
    if not helper.get("available"):
        print("Graph mode is unavailable: " + (helper.get("error") or "no graph helper was found") + ".\n"
              "  Looked at --graph-helper, $FIBERBROWSER_GRAPH_HELPER, fiberbrowser-graph on PATH and the companion "
              "package.\n  Pass --graph-helper PATH (a fiberbrowser-graph executable), set FIBERBROWSER_GRAPH_HELPER, "
              'or install the companion package: pip install "fiberbrowser[graph]".', flush=True)
        return
    regs = status.get("registrations") or []
    print(f"Graph helper ready ({helper.get('producer') or helper.get('path')}); "
          f"{len(regs)} graph package{'' if len(regs) == 1 else 's'} registered.", flush=True)
    for problem in status.get("registration_errors") or []:
        print(f"  Graph package problem: {problem}", flush=True)


def add_samples(a) -> None:
    settings = {"haplotype_mode": "pooled" if a.pooled else "split"}
    for s in a.sample:
        label, lifted, native = s[0], s[1], (s[2] if len(s) > 2 else None)
        body = {"paths": [lifted], "manifest": a.map, "haplotypes": [], "label": f"{label} (lifted)", "settings": settings}
        if a.source_fasta:
            body["source_fasta"] = a.source_fasta
        out = post(a.port, "/api/lift/datasets", body)
        if not out.get("success"):
            sys.exit(f"Could not add {label} as a live-lift dataset: {out.get('error')}")
        print(f"Added {label} (lifted)", flush=True)
        if native:
            out = post(a.port, "/api/datasets/add", {"path": native, "label": f"{label} ({a.native_label})"})
            if not out.get("success"):
                sys.exit(f"Could not add {label} ({a.native_label}): {out.get('error')}")
            print(f"Added {label} ({a.native_label})", flush=True)


def _interrupt(*_):
    raise KeyboardInterrupt


def main(argv=None):
    a = parse_args(argv)
    check_inputs(a)
    if not a.no_graph and a.graph_helper:
        print(f"Graph helper (from {a.graph_helper_source}): {a.graph_helper}", flush=True)
    a.home = full(a.home) if a.home else tempfile.mkdtemp(prefix="fiberbrowser-unified-")
    os.makedirs(a.home, exist_ok=True)
    if a.build and not a.frontend_dist:
        a.frontend_dist = os.path.join(a.home, "frontend-dist")
    if a.frontend_dist:
        a.frontend_dist = full(a.frontend_dist)
    if a.build:
        subprocess.run(["npx", "vite", "build", "--outDir", a.frontend_dist, "--emptyOutDir"],
                       cwd=os.path.join(ROOT, "browser", "frontend"), check=True)
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", a.port)) == 0:
            sys.exit(f"Port {a.port} is already in use: pick another with --port.")
    args = [a.python, "browser.py", "-p", str(a.port), "--no-open", "--no-token", "--copilot", "off"]
    if os.path.exists(a.fasta):
        args += ["--fasta", a.fasta]
    print("Server: " + shlex.join(args), flush=True)
    proc = subprocess.Popen(args, cwd=ROOT, env=server_env(a))
    # A plain kill of this script (SIGTERM) stops the server too, as Ctrl+C does.
    signal.signal(signal.SIGTERM, _interrupt)
    try:
        wait_ready(a.port, proc)
        add_samples(a)
        if not a.no_graph:
            warm_graph(a.port)
        if proc.poll() is not None:
            sys.exit("FiberBrowser exited while the samples were loading (see its output above).")
        chrom, span = a.view.replace(",", "").split(":")
        start, end = span.split("-")
        print(f"\nReady: http://localhost:{a.port}/?chr={chrom}&start={start}&end={end}")
        if a.locus_note:
            print(a.locus_note)
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
