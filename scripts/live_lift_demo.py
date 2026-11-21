#!/usr/bin/env python
"""Start a local FiberBrowser with the live-lift demo loaded (DESIGN_LIVE_LIFT.md P2a).

HG002-aligned reads at the chr3 AluY locus, drawn on GRCh38 through the
HPRC graphlift map (split into MAT and PAT panels), next to the same molecules'
native GRCh38 alignments. Runs until Ctrl+C.

    python scripts/live_lift_demo.py [--port 8883] [--data-root DIR] [--home DIR] [--build | --frontend-dist DIR]

The existing frontend build is used unless ``--build`` is explicitly requested.
The child server gets an isolated HOME by default; ``--home`` can name a persistent
demo directory. The real user's reference FASTA is read without changing HOME.
The server runs with FIBERBROWSER_LIVE_LIFT=1 on localhost
without an access token (a demo on this computer only)."""
import argparse
import json
import os
import pwd
import shlex
import tempfile
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
WORK = os.environ.get("PGLIFT_WORK", os.path.join(REAL_HOME, "pglift_work"))
HANDOFF = os.environ.get("LIVE_LIFT_DEMO_DATA", os.path.join(WORK, "demo_data"))
DEFAULT_MAP = os.path.join(WORK, "pglift_20261017/native/graphlift/scratch/v4/hprc.GRCh38.HG002.chain.graphlift.json")
DEFAULT_FASTA = os.path.join(REAL_HOME, ".fiberhmm/genomes/hg38.fa")
VIEW = "chr3:128,650,000-128,670,000"


def wait_ready(port: int, proc, timeout: float = 120.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit("FiberBrowser exited before it was ready (see its output above).")
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.5)
    sys.exit("FiberBrowser did not become ready in time.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8883)
    ap.add_argument("--fasta", default=DEFAULT_FASTA, help="GRCh38 FASTA (default: real user's ~/.fiberhmm/genomes/hg38.fa, read-only)")
    ap.add_argument("--data-root", default=HANDOFF, help="demo BAM directory (or LIVE_LIFT_DEMO_DATA)")
    ap.add_argument("--home", default=None, help="child server HOME (default: a new temporary directory)")
    ap.add_argument("--lift-bam", default=None)
    ap.add_argument("--native-bam", default=None)
    ap.add_argument("--map", default=DEFAULT_MAP)
    ap.add_argument("--pooled", action="store_true", help="one pooled panel instead of MAT and PAT panels")
    ap.add_argument("--build", action="store_true",
                    help="build the frontend of this branch into --frontend-dist first (never into the checkout's dist)")
    ap.add_argument("--frontend-dist", default=None,
                    help="frontend build to serve (FIBERBROWSER_FRONTEND_DIST; default with --build: <home>/frontend-dist, "
                         "else the checkout's browser/frontend/dist)")
    a = ap.parse_args()
    if a.port in (8885, 8886, 8888):
        sys.exit("Pick another port (8885, 8886 and 8888 are reserved on this machine).")
    a.data_root = os.path.abspath(os.path.expanduser(a.data_root))
    a.lift_bam = a.lift_bam or os.path.join(a.data_root, "sample.alu_chr3.hg002v1.1.bam")
    a.native_bam = a.native_bam or os.path.join(a.data_root, "sample.alu_chr3.GRCh38.bam")
    for name in ("lift_bam", "native_bam", "map"):
        setattr(a, name, os.path.abspath(os.path.expanduser(getattr(a, name))))
        if not os.path.exists(getattr(a, name)):
            sys.exit(f"Missing {name.replace('_', ' ')}: {getattr(a, name)}")
    a.home = os.path.abspath(os.path.expanduser(a.home)) if a.home else tempfile.mkdtemp(prefix="fiberbrowser-live-lift-")
    os.makedirs(a.home, exist_ok=True)
    if a.build and not a.frontend_dist:
        a.frontend_dist = os.path.join(a.home, "frontend-dist")
    if a.frontend_dist:
        a.frontend_dist = os.path.abspath(os.path.expanduser(a.frontend_dist))
    if a.build:
        # Built outside the checkout: a server already running from browser/frontend/dist keeps its assets.
        subprocess.run(["npx", "vite", "build", "--outDir", a.frontend_dist, "--emptyOutDir"],
                       cwd=os.path.join(ROOT, "browser", "frontend"), check=True)
    elif not a.frontend_dist:
        print("Using the checkout's frontend build; --build builds this branch into <home>/frontend-dist.", flush=True)
    fasta = os.path.abspath(os.path.expanduser(a.fasta))
    args = [sys.executable, "browser.py", "-b", a.native_bam, "-p", str(a.port), "--no-open", "--no-token"]
    if os.path.exists(fasta):
        args += ["--fasta", fasta]
    env = dict(os.environ, HOME=a.home, FIBERBROWSER_LIVE_LIFT="1", FIBERBROWSER_PORT_MIN=str(a.port),
               FIBERBROWSER_PORT_MAX=str(a.port), FIBERBROWSER_NO_OPEN="1",
               **({"FIBERBROWSER_FRONTEND_DIST": a.frontend_dist} if a.frontend_dist else {}))
    relaunch = [sys.executable, os.path.abspath(__file__), "--port", str(a.port), "--data-root", a.data_root,
                "--home", a.home, "--fasta", fasta, "--lift-bam", a.lift_bam, "--native-bam", a.native_bam, "--map", a.map]
    if a.pooled:
        relaunch.append("--pooled")
    if a.frontend_dist:
        relaunch += ["--frontend-dist", a.frontend_dist]
    print("Relaunch: " + shlex.join(relaunch), flush=True)
    proc = subprocess.Popen(args, cwd=ROOT, env=env)
    try:
        wait_ready(a.port, proc)
        body = json.dumps({"paths": [a.lift_bam], "manifest": a.map, "haplotypes": [],
                           "settings": {"haplotype_mode": "pooled" if a.pooled else "split"}}).encode()
        req = urllib.request.Request(f"http://localhost:{a.port}/api/lift/datasets", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read())
        if not out.get("success"):
            sys.exit(f"Could not add the live-lift dataset: {out.get('error')}")
        chrom, rest = VIEW.replace(",", "").split(":")
        start, end = rest.split("-")
        print(f"\nLive-lift demo ready: http://localhost:{a.port}/?chr={chrom}&start={start}&end={end}")
        print("Native GRCh38 panel, then the lifted HG002 MAT and PAT panels (badges: +2.4 kb at the AluY).")
        print("Open ▾ → Add live lift… opens another; a panel's … menu pools or splits haplotypes. Ctrl+C stops.\n", flush=True)
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
