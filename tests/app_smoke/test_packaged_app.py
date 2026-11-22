"""Packaged-app smoke (opt-in): the API-level checks of the 3.1.0 release smoke, as tests.

Ported: version and bundled FiberHMM; helper binaries free of the builder's home path; wizard runs (DddB FASTQ, Hia5
aligned/unaligned) with QC, Library QC and re-call, --min-mapq exactly once; recent/pinned genome and a saved default
layer colour across a restart; demo metaprofile, meta-locus pool and exact sequence search.
The browser-driven checks (layer-colour UI, cluster legend, Plots Compare with summary, full-UI capture, sessions
opened during start-up, graph view, FiberHMM update offer) are in test_packaged_app_ui.py.
Not ported: the 3.0.7 Read Stats driver (MA-only, Ma, legacy and uncalled reads), and the 3.0.8 metaprofile
comparison/timing and app-update offer checks (source-tree scripts).

See tests/app_smoke/conftest.py for how to run them. Each test opens the app on its own scratch HOME.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

import pysam
import pytest

APP = os.environ.get("FIBERBROWSER_APP_SMOKE_APP", "")  # see tests/app_smoke/conftest.py

CALL_TAGS = ("ns", "nl", "as", "al", "nq", "MA", "AQ")
WIZARD_OPTS = {"dedup": "auto", "dedup_mode": "flag", "snp_screen": "auto", "snp_mask": "", "chimera_filter": True,
               "alignments": "primary-supplementary", "prob_threshold": None, "use_m5c": "auto",
               "cpg_mask_policy": "unmethylated-only"}


def _version_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def _wait_job(app, job_id: str, limit: float = 1200) -> dict:
    t0 = time.time()
    while True:
        job = app.call("GET", f"/api/pipeline/jobs/{job_id}")
        job = job.get("job", job)
        if job.get("status") in ("error", "failed", "cancelled", "interrupted") or (job.get("status") == "done" and job.get("summary")):
            return job
        assert time.time() - t0 < limit, f"job {job_id} still {job.get('status')} after {limit} s"
        time.sleep(2)


def _read_names(path: str) -> set[str]:
    if path.endswith(".fastq"):
        return {line[1:].split()[0] for i, line in enumerate(open(path)) if i % 4 == 0}
    with pysam.AlignmentFile(path, check_sq=False) as b:
        return {r.query_name for r in b.fetch(until_eof=True) if not (r.is_secondary or r.is_supplementary)}


def _primary(path: str) -> list:
    with pysam.AlignmentFile(path, check_sq=False) as b:
        return [r for r in b.fetch(until_eof=True) if not (r.is_secondary or r.is_supplementary)]


def _job_argv(app, job_id: str) -> list[str]:
    spec = app.home / ".fiberhmm" / "jobs" / job_id / "spec.json"
    return json.loads(spec.read_text()).get("argv") or []


def test_version_and_bundled_fiberhmm(packaged_app):
    app = packaged_app("version")
    want = os.environ.get("FIBERBROWSER_APP_SMOKE_VERSION")
    if want:
        assert app.version["current"] == want, app.version
    status = app.call("GET", "/api/pipeline/status")
    assert status.get("available") and status.get("aligner", {}).get("ok"), status
    # The start-up banner names the FiberHMM the app runs: its own (bundled in Contents/Frameworks), at least the minimum.
    log = next(p for p in app.logs.iterdir() if p.name.startswith("test_version") and p.name.endswith("_stdout.log")).read_text()
    m = re.search(r"FiberHMM: (\S+) \((.*)\)", log)
    assert m, log[-2000:]
    assert _version_tuple(m.group(1)) >= _version_tuple(os.environ.get("FIBERBROWSER_APP_SMOKE_FIBERHMM_MIN", "3.2.2")), m.group(0)
    assert m.group(2).startswith(str(Path(APP).resolve() / "Contents")) or "/Contents/Frameworks/" in m.group(2), m.group(0)


def test_bundled_binaries_carry_no_builder_home_path():
    """Release check of 3.1.0: no bundled helper binary names the builder's home folder."""
    contents = Path(APP) / "Contents"
    home_prefix = "/" + "Users" + "/"
    checked = 0
    for rel in ("Frameworks/graph-helper/fiberbrowser-graph", "Helpers/minimap2"):
        exe = contents / rel
        if not exe.exists():
            continue
        out = subprocess.run(["strings", "-a", str(exe)], capture_output=True, text=True).stdout
        hits = [line for line in out.splitlines() if home_prefix in line]
        assert not hits, f"{rel}: {hits[:5]}"
        checked += 1
    assert checked, "neither bundled helper found in the app"


_TLS_PROBE = (
    "import json, os, ssl; p = ssl.get_default_verify_paths(); "
    "print('TLS ' + json.dumps({'ssl_cert_file': os.environ.get('SSL_CERT_FILE'), "
    "'curl_ca_bundle': os.environ.get('CURL_CA_BUNDLE'), 'openssl_cafile': p.openssl_cafile, "
    "'cas': ssl.create_default_context().cert_store_stats()['x509_ca']}))")


def _tls_probe(tmp_path: Path, deny: str | None = None) -> dict:
    """The app's own interpreter (its ``-c`` role) reports the CA file its HTTPS uses and how many CAs a default
    context loads; with ``deny``, that folder is unreadable to it (sandbox-exec), as on any Mac but the builder's."""
    exe = Path(APP) / "Contents" / "MacOS" / "FiberBrowser"
    cmd = [str(exe), "-c", _TLS_PROBE]
    if deny:
        profile = tmp_path / "deny.sb"
        profile.write_text(f'(version 1)\n(allow default)\n(deny file-read* (subpath "{deny}"))\n')
        cmd = ["/usr/bin/sandbox-exec", "-f", str(profile)] + cmd
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin", "TMPDIR": os.environ.get("TMPDIR", "/tmp")}
    out = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env, timeout=300,
                         start_new_session=True).stdout
    line = next((x for x in out.splitlines() if x.startswith("TLS ")), None)
    assert line, out[-2000:]
    return json.loads(line[4:])


def test_https_trusts_the_bundled_ca_file_not_a_build_machine_path(tmp_path):
    """3.0.0-3.1.0: the bundled OpenSSL's default CA file was in the builder's conda env, so on every other Mac the
    FiberHMM and app update checks failed with CERTIFICATE_VERIFY_FAILED. The app now points its HTTPS (Python and
    htslib's libcurl) at the bundled certifi file, and still loads CAs with the OpenSSL default folder unreadable."""
    bundle = str(Path(APP).resolve() / "Contents")
    seen = _tls_probe(tmp_path)
    assert seen["ssl_cert_file"] and str(Path(seen["ssl_cert_file"]).resolve()).startswith(bundle), seen
    assert seen["curl_ca_bundle"] == seen["ssl_cert_file"], seen
    assert seen["cas"] > 50, seen
    default_dir = os.path.dirname(seen["openssl_cafile"])
    if default_dir and not str(Path(default_dir).resolve()).startswith(bundle):
        blocked = _tls_probe(tmp_path, deny=default_dir)
        assert blocked["cas"] == seen["cas"], (seen, blocked)


def test_wizard_runs_qc_and_library_recall(packaged_app, smoke_inputs, smoke_root):
    """Wizard runs (DddB FASTQ, Hia5 aligned and unaligned BAMs) with the bundled FiberHMM: every input read is in the
    output, the calls carry their tags, the run passes --min-mapq exactly once (0 by default); the QC panel and
    Library QC answer; a Library re-call plan and its job pass --min-mapq exactly once and finish."""
    app = packaged_app("wizard")
    work = smoke_root / "work"
    called = {}
    for label, reads, enzyme in (("dddb_fastq", smoke_inputs["fastq"], "dddb"), ("hia5_bam_aligned", smoke_inputs["hia5"], "hia5"),
                                 ("hia5_bam_unaligned", smoke_inputs["hia5u"], "hia5")):
        scan = app.call("POST", "/api/pipeline/scan", {"paths": [reads], "input_kind": "reads"})
        assert scan.get("success"), scan
        (sample,) = scan["samples"]
        body = {"samples": [{"name": sample["name"], "files": sample["files"]}], "reference": {"kind": "file", "path": smoke_inputs["fasta"]},
                "regions": [], "enzyme": enzyme, "output_root": str(work / "runs" / label), "cores": 2,
                "options": dict(WIZARD_OPTS), "auto_open": False, "input_kind": "reads"}
        check = app.call("POST", "/api/pipeline/validate", body)
        assert check.get("ok"), check
        assert "--min-mapq" in json.dumps(check) or "MAPQ 0" in json.dumps(check), "the run plan does not show its MAPQ"
        job = _wait_job(app, app.call("POST", "/api/pipeline/jobs", body)["jobs"][0]["id"])
        assert job.get("status") == "done", (label, job.get("status"), job.get("error"), job.get("hint"))
        argv = _job_argv(app, job["id"])
        assert argv.count("--min-mapq") == 1 and argv[argv.index("--min-mapq") + 1] == "0", argv
        out = job["outputs"]["called_bam"]
        recs = _primary(out)
        assert sorted(r.query_name for r in recs) == sorted(_read_names(reads)), f"{label}: reads lost or added"
        calls = [r for r in recs if r.has_tag("ns")]
        assert calls, f"{label}: no read was called"
        missing = {t: sum(not r.has_tag(t) for r in calls) for t in CALL_TAGS}
        assert not any(missing.values()), (label, missing)
        qc = app.call("GET", f"/api/pipeline/jobs/{job['id']}/qc")
        assert "http_error" not in qc, qc
        called[label] = out

    for label in ("dddb_fastq", "hia5_bam_aligned"):
        added = app.call("POST", "/api/datasets/add", {"path": called[label], "label": label})
        did = added.get("id") or added.get("dataset_id") or (added.get("dataset") or {}).get("id")
        assert did, added
        qc = app.call("POST", "/api/qc/dataset", {"dataset_id": did, "enzyme": "auto"}, timeout=900)
        assert qc.get("success"), (label, {k: qc.get(k) for k in ("success", "error", "http_error", "body")})

    for label in ("dddb_fastq", "hia5_bam_aligned"):
        path = called[label]
        add = app.call("POST", "/api/library/entries", {"paths": [path]})
        entries = add.get("entries") or add.get("added") or []
        eid = entries[0].get("id") if entries and isinstance(entries[0], dict) else None
        if not eid:
            eid = next((e["id"] for e in app.call("GET", "/api/library").get("entries", []) if e.get("path") == path), None)
        assert eid, add
        run = app.call("POST", f"/api/library/entries/{eid}/qc/run", {"confirm": True}, timeout=900)
        assert "http_error" not in run, run
        lqc = app.call("GET", f"/api/library/entries/{eid}/qc")
        assert {"available", "qc"} <= set(lqc), sorted(lqc)
        outdir = str(work / "recall" / label)
        plan = app.call("POST", f"/api/library/entries/{eid}/recall", {"dry_run": True, "outdir": outdir, "cores": 2})
        assert plan.get("success"), plan
        assert (plan["plan"].get("extra") or []).count("--min-mapq") == 1, plan["plan"].get("extra")
        start = app.call("POST", f"/api/library/entries/{eid}/recall", {"plan_id": plan["plan"]["plan_id"], "outdir": outdir, "cores": 2})
        job = _wait_job(app, (start.get("job") or {})["id"])
        assert job.get("status") == "done", (label, job.get("error"), job.get("hint"))
        assert _job_argv(app, job["id"]).count("--min-mapq") == 1
        out = (job.get("outputs") or {}).get("called_bam") or plan["plan"].get("output_bam")
        assert len(_primary(out)) == len(_primary(path)), f"{label}: the re-call changed the read count"


def test_recent_genome_pin_and_layer_colour_survive_a_restart(packaged_app, smoke_inputs):
    """Recent and pinned genomes, and a saved default layer colour, are kept in the app's HOME across a restart."""
    app = packaged_app("restart")
    assert app.call("POST", "/api/load_fasta?" + urllib.parse.urlencode({"path": smoke_inputs["fasta"]})).get("success")
    assert app.call("POST", "/api/load_gtf?" + urllib.parse.urlencode({"path": smoke_inputs["gtf"]})).get("success") is not False
    listing = app.call("GET", "/api/recent_genomes")
    entry = next((e for e in listing["recent"] + listing["pinned"] if e.get("fasta") == smoke_inputs["fasta"]), None)
    assert entry and entry.get("gtf") == smoke_inputs["gtf"], listing
    pinned = app.call("POST", "/api/recent_genomes/pin", {"key": entry["key"], "pinned": True})
    assert "http_error" not in pinned, pinned
    prefs = app.call("PUT", "/api/preferences/analysis", {"layer_colors": {"nuc": "#FFD400"}})
    assert prefs.get("layer_colors", {}).get("nuc") == "#ffd400", prefs
    app.stop()

    again = packaged_app("restart")
    listing = again.call("GET", "/api/recent_genomes")
    kept = next((e for e in listing["pinned"] if e.get("key") == entry["key"]), None)
    assert kept and kept.get("gtf") == smoke_inputs["gtf"] and kept.get("exists"), listing
    assert again.call("GET", "/api/preferences/analysis").get("layer_colors", {}).get("nuc") == "#ffd400"
    opened = again.call("POST", "/api/recent_genomes/open", {"key": entry["key"]})
    assert opened.get("success"), opened


def test_demo_metaprofile_meta_locus_and_sequence_search(packaged_app, smoke_inputs, smoke_root):
    """The bundled demo opens, its server metaprofile values are finite, a meta-locus pool builds from a BED
    and serves reads; an exact sequence search over a loaded FASTA finds the planted query."""
    app = packaged_app("views")
    demo = app.call("POST", "/api/demo/load")
    assert demo.get("success"), demo
    did, reg = demo["dataset_id"], demo["region"]
    q = urllib.parse.urlencode({"chrom": reg["chrom"], "start": reg["start"], "end": reg["end"], "dataset_id": did,
                                "include_metaprofile": "true", "include_layers": "true", "max_reads": 500, "metaprofile_layers": "tf,nuc,msp"})
    r = app.call("GET", f"/api/reads/compact?{q}")
    assert r.get("reads"), {k: r.get(k) for k in ("success", "error")}
    values = []

    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list) and o and all(isinstance(x, (int, float)) or x is None for x in o):
            values.extend(x for x in o if x is not None)
    walk({k: v for k, v in (r.get("metaprofile") or {}).items() if k not in ("coverage", "counts", "n", "bins", "positions")})
    assert values and all(math.isfinite(x) for x in values)

    centre = (reg["start"] + reg["end"]) // 2
    bed = smoke_root / "demo_sites.bed"
    bed.write_text("".join(f"{reg['chrom']}\t{centre + d - 100}\t{centre + d + 100}\tsite{i}\t0\t+\n" for i, d in enumerate((-800, 0, 800))))
    pool = app.call("POST", "/api/meta_locus/pools", {"bed_path": str(bed), "dataset_ids": [did], "name": "smoke"})
    assert pool.get("pool_id"), pool
    t0 = time.time()
    while pool.get("status") not in ("ready", "error", "failed", "cancelled") and time.time() - t0 < 300:
        time.sleep(1)
        pool = app.call("GET", f"/api/meta_locus/pools/{pool['pool_id']}")
    assert pool.get("status") == "ready", pool
    assert pool["sites"] == 3 and pool["chrom"] == f"meta:{pool['pool_id']}"
    reads = app.call("POST", f"/api/meta_locus/pools/{pool['pool_id']}/reads", {"seed": 1, "count": 200})
    assert reads.get("reads"), {k: reads.get(k) for k in ("success", "error", "http_error")}

    assert app.call("POST", "/api/load_fasta?" + urllib.parse.urlencode({"path": smoke_inputs["fasta"]})).get("success")
    query = smoke_inputs["genome"]["chrA"][12345:12385]
    started = app.call("POST", "/api/sequence_search", {"sequence": query, "mode": "exact"})
    assert started.get("success"), started
    t0 = time.time()
    job = started
    while job.get("status") not in ("done", "error", "failed", "cancelled", "missing") and time.time() - t0 < 120:
        time.sleep(1)
        job = app.call("GET", f"/api/sequence_search/jobs/{started['job_id']}")
    assert job.get("status") == "done", job
    hits = job["result"]["hits"]
    assert any(h["chrom"] == "chrA" and h["start"] == 12345 and h["end"] == 12385 for h in hits), hits[:5]
