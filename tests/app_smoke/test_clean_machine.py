"""Clean-machine checks: the packaged app on a Mac that is not the build Mac (opt-in, see conftest.py).

FiberBrowser 3.0.0-3.1.0 passed every packaged-app smoke on the build Mac, yet on users' Macs every HTTPS request made
with Python's default TLS settings failed (CERTIFICATE_VERIFY_FAILED): the bundled conda OpenSSL looked for its CA
file inside the builder's conda env. Update checks, catalog genome and annotation downloads, remote BAMs over https,
UCSC/ENCODE/track-hub fetches and the Dfam library all broke. These checks run the app with the builder's folders
hidden (FIBERBROWSER_APP_SMOKE_CLEAN_MACHINE=1) and exercise each feature that reaches the network, a helper program or
a file outside the app. Checks marked network also need FIBERBROWSER_APP_SMOKE_NETWORK=1; they download a few MB
(sacCer3 3.8 MB, a 1 MB slice of an update zip, a FiberHMM wheel, remote file headers and indexes).
"""
from __future__ import annotations

import json
import os
import time
import urllib.parse
from pathlib import Path

import pytest

from app_smoke.conftest import APP, CLEAN_MACHINE, NETWORK, builder_paths, real_home

pytestmark = pytest.mark.skipif(not CLEAN_MACHINE, reason="clean-machine checks: set FIBERBROWSER_APP_SMOKE_CLEAN_MACHINE=1")
network = pytest.mark.skipif(not NETWORK, reason="network check: set FIBERBROWSER_APP_SMOKE_NETWORK=1")
MAX_GENOME_BYTES = 200 << 20   # never more: the check picks the catalog's smallest genome (sacCer3)
REMOTE_BAM = ("https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/phase3/data/HG00096/alignment/"
              "HG00096.chrom20.ILLUMINA.bwa.GBR.low_coverage.20120522.bam")
REMOTE_BIGWIG = "https://hgdownload.soe.ucsc.edu/goldenPath/dm6/phastCons27way/dm6.27way.phastCons.bw"
TRACK_HUB = "https://genome.ucsc.edu/goldenPath/help/examples/hubDirectory/hub.txt"


def _q(text: str) -> str:
    return urllib.parse.quote(text, safe="")


def _in_bundle(path) -> bool:
    return bool(path) and Path(path).resolve().is_relative_to(Path(APP).resolve())


def _lines(proc) -> dict:
    """``name: OK ...`` / ``name: FAILED ...`` lines printed by an in-app script -> {name: line}."""
    out = {}
    for line in (proc.stdout or "").splitlines():
        if ": OK" in line or ": FAILED" in line:
            out[line.split(":", 1)[0]] = line
    return out


def test_the_sandbox_hides_the_builders_folders(in_app):
    """The harness itself: inside the sandbox the builder's home and Homebrew can't be read, so a check that passes
    here doesn't lean on them."""
    # /Applications itself stays listable (Safari is allowed); its other apps are hidden.
    paths = [p for p in builder_paths() if os.path.isdir(p) and p != "/Applications"]
    paths += [str(p) for p in sorted(Path("/Applications").glob("*.app")) if p.name != "Safari.app"][:3]
    code = ("import os, sys\n"
            f"for p in {paths!r}:\n"
            "    try:\n        os.listdir(p); print(p + ': READABLE')\n"
            "    except PermissionError:\n        print(p + ': hidden')\n")
    proc = in_app(code, "sandbox_probe")
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "READABLE" not in proc.stdout and f"{real_home()}: hidden" in proc.stdout, proc.stdout


def test_the_bundle_carries_no_builder_home_path():
    """No file in the app names the builder's home (3.0.x-3.1.0 shipped 45 numba cache files under pynndescent that
    did, and a libcrypto whose CA file and a libcurl whose CA bundle were in the builder's conda env)."""
    needle = (real_home().rstrip("/") + "/").encode()
    hits = []
    for path in Path(APP).rglob("*"):
        if path.is_file() and not path.is_symlink():
            try:
                if needle in path.read_bytes():
                    hits.append(str(path.relative_to(APP)))
            except OSError:
                continue
    assert not hits, f"{len(hits)} file(s) carry the builder's home: {hits[:20]}"


def test_bundled_helper_programs_are_found_inside_the_app(packaged_app, smoke_inputs):
    """minimap2, BLAST+ and the graph helper come from the app (no Homebrew or conda on PATH here)."""
    app = packaged_app("helpers", args=["--fasta", smoke_inputs["fasta"]])
    status = app.call("GET", "/api/pipeline/status?refresh=true")
    aligner = status.get("aligner") or {}
    assert aligner.get("ok"), status
    search = app.call("GET", "/api/sequence_search/status")
    assert (search.get("blast") or {}).get("available"), search
    primer = app.call("GET", "/api/primer_config")
    blast = primer.get("blast_tool") or {}
    assert blast.get("ok") and _in_bundle((blast.get("blastn") or {}).get("path")), blast
    graph = app.call("GET", "/api/graph/status")
    helper = graph.get("helper") or {}
    assert helper.get("available") and _in_bundle(helper.get("path")), helper


def test_wizard_blast_and_primers_on_a_clean_machine(packaged_app, smoke_inputs, smoke_root):
    """A FASTQ run (minimap2 + fiberhmm-call + QC), a BLAST search and primer design, all with the bundled tools."""
    app = packaged_app("tools_run", args=["--fasta", smoke_inputs["fasta"]])
    scan = app.call("POST", "/api/pipeline/scan", {"paths": [smoke_inputs["fastq"]], "input_kind": "reads"})
    sample = scan["samples"][0]
    body = {"samples": [{"name": sample["name"], "files": sample["files"]}], "reference": {"kind": "file", "path": smoke_inputs["fasta"]},
            "regions": [], "enzyme": "dddb", "output_root": str(smoke_root / "tools_run" / "run"), "cores": 2,
            "auto_open": False, "input_kind": "reads"}
    job_id = app.call("POST", "/api/pipeline/jobs", body)["jobs"][0]["id"]
    deadline = time.time() + 900
    while True:
        job = app.call("GET", f"/api/pipeline/jobs/{job_id}")
        job = job.get("job", job)
        if job.get("status") in ("error", "failed", "cancelled", "interrupted") or (job.get("status") == "done" and job.get("summary")):
            break
        assert time.time() < deadline, job
        time.sleep(2)
    assert job.get("status") == "done", (job.get("error"), job.get("hint"))
    query = smoke_inputs["genome"]["chrA"][5000:5300]
    started = app.call("POST", "/api/sequence_search", {"sequence": query, "mode": "blast"})
    job_id = started.get("job_id") or (started.get("job") or {}).get("id") or started.get("id")
    assert job_id, started
    for _ in range(300):
        res = app.call("GET", f"/api/sequence_search/jobs/{job_id}")
        if res.get("status") in ("done", "error", "cancelled"):
            break
        time.sleep(1)
    result = res.get("result") or res
    assert res.get("status") == "done" and result.get("total", 0) >= 1, res
    built = app.call("POST", "/api/primer_blast_db/build?force=true")
    assert built.get("success"), built
    primers = app.call("POST", "/api/design_primers", {"chrom": "chrA", "start": 8000, "end": 12000}, timeout=900)
    assert primers.get("success") and primers.get("pairs"), {k: primers.get(k) for k in ("success", "error", "message")}


def test_headless_figures_and_exports(packaged_app, smoke_inputs):
    """PNG/SVG/PDF figures (PDF with embedded TrueType fonts from the system) and a BAM export of chosen reads."""
    app = packaged_app("exports", args=["--fasta", smoke_inputs["fasta"], "--bam", smoke_inputs["hia5"]])
    for fmt, extra, magic in (("png", {}, b"\x89PNG"), ("svg", {}, b"<svg"), ("pdf", {}, b"%PDF"),
                              ("pdf", {"pdf_fonts": "truetype"}, b"%PDF")):
        import urllib.request
        req = urllib.request.Request(app.base + "/api/render", method="POST", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"chrom": "chrA", "start": 1000, "end": 6000, "format": fmt, **extra}).encode())
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=300) as r:
            data = r.read()
        assert data.startswith(magic), (fmt, extra, data[:200])
        if extra:
            assert b"FontFile2" in data, "pdf_fonts=truetype embedded no TrueType font"
    import pysam
    with pysam.AlignmentFile(smoke_inputs["hia5"]) as bam:
        names = [r.query_name for r in bam.fetch("chrA")][:2]
    datasets = app.call("GET", "/api/datasets")
    did = (datasets.get("datasets") or [{}])[0].get("id")
    req = urllib.request.Request(app.base + "/api/reads/export_bam", method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"dataset_id": did, "chrom": "chrA", "start": 0, "end": 20000, "read_ids": names}).encode())
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=120) as r:
        assert r.read(2) == b"\x1f\x8b"   # BGZF


def test_lab_server_starts(packaged_app, smoke_inputs, smoke_root):
    """A lab server (accounts) starts from its TOML and asks visitors to sign in."""
    lab = smoke_root / "lab"
    (lab / "state").mkdir(parents=True, exist_ok=True)
    (lab / "runs").mkdir(exist_ok=True)
    config = lab / "lab.toml"
    config.write_text(f'profile = "lab"\n[server]\nhost = "127.0.0.1"\n[data]\nfasta = "{smoke_inputs["fasta"]}"\n'
                      f'[[data.roots]]\npath = "{Path(smoke_inputs["fasta"]).parent}"\nlabel = "Lab data"\nwritable = false\n'
                      f'[[data.roots]]\npath = "{lab / "runs"}"\nlabel = "Runs"\nwritable = true\n'
                      f'[state]\ndir = "{lab / "state"}"\n[auth]\nmode = "accounts"\n[jobs]\nenabled = true\n')
    signin = lambda v: isinstance(v, dict) and v.get("http_error") == 401 and "Sign in" in v.get("body", "")
    app = packaged_app("lab_home", args=["--config", str(config)], ready=signin)
    assert signin(app.version), app.version


# --- network ------------------------------------------------------------------------------------------------------

@network
def test_https_trust_in_the_apps_interpreter(in_app):
    """Every HTTPS client in the app trusts public certificates without the builder's CA file: urllib (update checks,
    downloads, UCSC/ENCODE/Dfam), aiohttp, requests, htslib (pysam, remote BAM) and libcurl (pyBigWig)."""
    code = f"""
import json, ssl, urllib.request
def run(name, fn):
    try:
        print(name + ": OK", fn())
    except BaseException as e:
        print(name + ": FAILED", type(e).__name__, str(e)[:300])
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={{"User-Agent": "FiberBrowser smoke"}}), timeout=30) as r:
        return r.status
run("urllib pypi", lambda: get("https://pypi.org/pypi/fiberhmm/json"))
run("urllib github", lambda: get("https://api.github.com/repos/fiberseq/FiberBrowser/releases/latest"))
run("urllib ucsc", lambda: get("https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/md5sum.txt"))
run("urllib dfam", lambda: get("https://www.dfam.org/api/version"))
def req():
    import requests
    return requests.get("https://pypi.org/pypi/fiberhmm/json", timeout=30).status_code
run("requests", req)
def aio():
    import asyncio, aiohttp
    async def f():
        async with aiohttp.ClientSession() as s:
            async with s.get("https://pypi.org/pypi/fiberhmm/json") as r:
                return r.status
    return asyncio.run(f())
run("aiohttp", aio)
def bam():
    import pysam
    with pysam.AlignmentFile({REMOTE_BAM!r}) as f:
        return f.references[:1]
run("pysam https", bam)
def bw():
    import pyBigWig
    b = pyBigWig.open({REMOTE_BIGWIG!r})
    try:
        return len(b.chroms())
    finally:
        b.close()
run("pyBigWig https", bw)
"""
    proc = in_app(code, "tls_probe", network=True, timeout=300)
    lines = _lines(proc)
    assert len(lines) == 8, proc.stdout + proc.stderr[-2000:]
    failed = [line for line in lines.values() if ": FAILED" in line]
    assert not failed, failed


@network
def test_update_checks_reach_github_and_pypi(packaged_app):
    app = packaged_app("updates", network=True)
    check = app.call("GET", "/api/app/update?force=true")
    assert check.get("status") in ("up_to_date", "update_available"), {k: check.get(k) for k in ("status", "message")}
    fh = check.get("fiberhmm") or {}
    assert fh.get("status") in ("up_to_date", "update_available"), fh


@network
def test_app_update_download_host_is_reachable(in_app):
    """The update download reads a GitHub release asset (a redirect to GitHub's asset host): the first 1 MB of the
    published 3.1.0 zip, through the updater's own http_get."""
    code = """
import json
from services import github_auth
rel = json.loads(github_auth.http_get("https://api.github.com/repos/fiberseq/FiberBrowser/releases/tags/v3.1.0",
                                      accept="application/vnd.github+json").read())
asset = next(a for a in rel["assets"] if a["name"].endswith("-arm64.zip"))
r = github_auth.http_get(asset["url"], accept="application/octet-stream", timeout=60)
head = r.read(1 << 20); r.close()
print("download: OK" if head[:2] == b"PK" and len(head) == 1 << 20 else "download: FAILED", len(head))
"""
    proc = in_app(code, "update_download", network=True, timeout=300)
    assert "download: OK" in proc.stdout, proc.stdout + proc.stderr[-2000:]


@network
def test_fiberhmm_update_installs_into_an_overlay(in_app):
    """The app's own FiberHMM installer downloads the newest supported wheel from PyPI, verifies and unpacks it into
    ~/.fiberhmm/fiberhmm/<version>/site (a scratch HOME here), and a child process of the app then imports it."""
    code = """
import json, subprocess, sys, time
from services import fiberhmm_update as fu
offer = fu.select_release(json.loads(fu._read_url(fu.PYPI_JSON_URL, 8 << 20)))
fu._offer = offer          # offered even when the bundled FiberHMM is already this version
fu.start_install()
for _ in range(300):
    st = fu.status()
    if st.get("state") != "installing":
        break
    time.sleep(1)
print("install:", json.dumps(st))
child = ("from services.fiberhmm_runtime import configure_fiberhmm_runtime as c; c(); import fiberhmm; "
         "print('child', fiberhmm.__version__, fiberhmm.__file__)")
r = subprocess.run([sys.executable, "-c", child], capture_output=True, text=True, timeout=300)
print(r.stdout.strip(), r.stderr[-500:])
print("offer", offer["version"])
"""
    proc = in_app(code, "fiberhmm_install", network=True, timeout=600)
    out = proc.stdout
    assert '"state": "ready"' in out, out + proc.stderr[-2000:]
    version = out.split("offer ")[-1].strip()
    assert f"child {version} " in out and "/.fiberhmm/fiberhmm/" in out, out


@network
def test_catalog_genome_annotation_and_remote_tracks(packaged_app):
    """The catalog's smallest genome (sacCer3: FASTA from UCSC, GTF from Ensembl) downloads, indexes and loads; then
    a UCSC API track, an ENCODE file search, a track hub, a remote BAM and a remote bigWig over https, and the JASPAR
    TF-name lookup (which needed httpx, not in the app, before 3.1.1)."""
    app = packaged_app("catalog", network=True)
    size = app.call("GET", "/api/pipeline/genome_download/size?genome_id=sacCer3")
    assert size.get("bytes") and size["bytes"] < MAX_GENOME_BYTES, size
    app.call("POST", "/api/pipeline/genome_download?genome_id=sacCer3")
    for _ in range(300):
        dl = app.call("GET", "/api/pipeline/genome_download?genome_id=sacCer3")
        if dl.get("state") in ("done", "error", "cancelled", "confirm"):
            break
        time.sleep(1)
    assert dl.get("state") == "done" and dl.get("fasta"), {k: dl.get(k) for k in ("state", "error", "errors")}
    loaded = app.call("POST", "/api/load_genome?genome_id=sacCer3", timeout=900)
    assert loaded.get("fasta_loaded") and loaded.get("gtf_loaded"), loaded
    track = app.call("POST", "/api/add_track?path=" + _q("ucsc://sacCer3/gc5BaseBw"))
    assert track.get("success"), track
    data = app.call("GET", f"/api/tracks/{track['track_index']}?chrom=chrI&start=0&end=20000")
    assert data.get("values"), {k: data.get(k) for k in ("label", "error")}
    encode = app.call("GET", "/api/encode/search?genome=hg38&assay=DNase-seq", timeout=120)
    assert encode.get("tracks") and not encode.get("error"), {k: encode.get(k) for k in ("error",)}
    link = app.call("POST", "/api/session-links", {"hub": TRACK_HUB, "genome": "hg19"})
    assert link.get("id"), link
    fetched = app.call("GET", f"/api/session-links/{link['id']}?fetch=true", timeout=120)
    assert fetched.get("success") and fetched.get("tracks"), {k: fetched.get(k) for k in ("error", "message", "http_error")}
    bam = app.call("POST", "/api/datasets/add_url?url=" + _q(REMOTE_BAM), timeout=180)
    assert bam.get("success"), bam
    bw = app.call("POST", "/api/add_track?path=" + _q(REMOTE_BIGWIG), timeout=180)
    assert bw.get("success"), bw
    names = app.call("GET", "/api/bigbed/names?genome=dm6&url=" + _q("https://example.invalid/tfbs.bb"), timeout=120)
    assert names.get("success") and len(names.get("names", [])) > 100, {k: names.get(k) for k in ("success", "error", "http_error", "body")}
