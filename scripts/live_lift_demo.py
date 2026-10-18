#!/usr/bin/env python
"""Start a local FiberBrowser with the live-lift demo loaded (DESIGN_LIVE_LIFT.md P2a).

SAMPLE_A's HG002-aligned reads at the chr3 AluY locus, drawn on GRCh38 through the
HPRC graphlift map (split into MAT and PAT panels), next to the same molecules'
native GRCh38 alignments. Runs until Ctrl+C.

    python scripts/live_lift_demo.py [--port 8882] [--fasta ~/.fiberhmm/genomes/hg38.fa] [--build]

The frontend must be built from this branch (``--build`` runs ``npm run build`` in
browser/frontend; ``git checkout -- browser/frontend/dist`` restores the committed
build afterwards). The server runs with FIBERBROWSER_LIVE_LIFT=1 on localhost
without an access token (a demo on this computer only)."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")
HANDOFF = os.path.join(HOME, "pglift_work/demo_data")
DEFAULTS = {
    "lift_bam": os.path.join(HANDOFF, "SAMPLE_A.alu_chr3.hg002v1.1.bam"),
    "native_bam": os.path.join(HANDOFF, "SAMPLE_A.alu_chr3.GRCh38.bam"),
    "map": os.path.join(HOME, "pglift_work/pglift_20261017/native/graphlift/scratch/v4/hprc.GRCh38.HG002.chain.graphlift.json"),
}
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
    ap.add_argument("--port", type=int, default=8882)
    ap.add_argument("--fasta", default=None, help="GRCh38 FASTA (default: ~/.fiberhmm/genomes/hg38.fa if present)")
    ap.add_argument("--lift-bam", default=DEFAULTS["lift_bam"])
    ap.add_argument("--native-bam", default=DEFAULTS["native_bam"])
    ap.add_argument("--map", default=DEFAULTS["map"])
    ap.add_argument("--pooled", action="store_true", help="one pooled panel instead of MAT and PAT panels")
    ap.add_argument("--build", action="store_true", help="build the frontend first (npm run build)")
    a = ap.parse_args()
    if a.port in (8885, 8886, 8888):
        sys.exit("Pick another port (8885, 8886 and 8888 are reserved on this machine).")
    for name in ("lift_bam", "native_bam", "map"):
        if not os.path.exists(getattr(a, name)):
            sys.exit(f"Missing {name.replace('_', ' ')}: {getattr(a, name)}")
    if a.build:
        subprocess.run(["npm", "run", "build"], cwd=os.path.join(ROOT, "browser", "frontend"), check=True)
    fasta = a.fasta or os.path.join(HOME, ".fiberhmm/genomes/hg38.fa")
    args = [sys.executable, "browser.py", "-b", a.native_bam, "-p", str(a.port), "--no-open", "--no-token"]
    if os.path.exists(fasta):
        args += ["--fasta", fasta]
    env = dict(os.environ, FIBERBROWSER_LIVE_LIFT="1", FIBERBROWSER_PORT_MIN=str(a.port),
               FIBERBROWSER_PORT_MAX=str(a.port), FIBERBROWSER_NO_OPEN="1")
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
