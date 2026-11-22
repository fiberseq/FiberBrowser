"""Pooled loci end to end with real headless servers: fiberbrowser render builds a pool from a small BED on the demo BAM
and draws a PDF with a receipt; re-clustering is identical across processes; fiberbrowser quantify writes the Quantify
table and the metaprofile from the saved session; the CLI's numbers equal the client's."""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DEMO = REPO / "browser" / "data" / "demo" / "napa_ddda.bam"


def _env(tmp_path, **extra):
    return {**os.environ, "PYTHONPATH": str(REPO), "FIBERBROWSER_META_LOCUS_CACHE_DIR": str(tmp_path / "mlcache"),
            **extra}


def _cli(tmp_path, *args, env=None, ok=True):
    from port_list import free_test_port
    run = subprocess.run([sys.executable, "-m", "fiberbrowser", *args, "--port", str(free_test_port())],
                         cwd=str(REPO), env=env or _env(tmp_path), capture_output=True, text=True, timeout=600)
    if ok:
        assert run.returncode == 0, run.stderr[-3000:]
    return run


@pytest.mark.slow
def test_render_recluster_and_quantify_pooled_loci_from_the_command_line(tmp_path):
    pypdf = pytest.importorskip("pypdf")
    from test_headless_meta_locus import bed_file
    bed = bed_file(tmp_path)
    pool = ["--bed", str(bed), "--anchor", "start", "--flank", "1500", "--seed", "1", "--count", "300",
            "--bam", f"{DEMO}:demo"]

    # 1. A PDF of the pool, aligned on the anchor; the receipt records the pool.
    out = tmp_path / "meta.pdf"
    run = _cli(tmp_path, "render", *pool, "--out", str(out), "--size", "180x120mm", "--fonts", "truetype",
               "--min-font", "6", "--read-ids")
    assert "wrote" in run.stdout
    reader = pypdf.PdfReader(io.BytesIO(out.read_bytes()))
    text = reader.pages[0].extract_text()
    assert "demo_sites" in text and "TSS" in text
    receipt = json.loads((tmp_path / "meta.pdf.receipt.json").read_text())
    ml = receipt["meta_locus"]
    assert ml["bed_sha256"] == hashlib.sha256(bed.read_bytes()).hexdigest()
    assert (ml["anchor"], ml["flank_bp"], ml["seed"], ml["count"], ml["sites"]) == ("start", 1500, 1, 300, 8)
    assert ml["read_site_pairs"] > 300 and len(ml["spec_hash"]) == 64 and ml["datasets"]
    assert str(bed) in {i["path"] for i in receipt["inputs"]}
    assert sum(p["reads_drawn"] for p in receipt["read_counts"]) == 300

    # 2. Re-cluster (kmeans:3) in two processes with different hash seeds: identical TSV, counts and PDF.
    outputs = []
    for hash_seed in ("1", "4242"):
        o = tmp_path / f"rc{hash_seed}.pdf"
        _cli(tmp_path, "render", *pool, "--out", str(o), "--recluster", "kmeans:3", "--cluster-seed", "meta",
             "--cluster-tsv", str(tmp_path / f"c{hash_seed}.tsv"), "--save-session", str(tmp_path / f"s{hash_seed}.json"),
             "--no-receipt", env=_env(tmp_path, PYTHONHASHSEED=hash_seed))
        outputs.append(((tmp_path / f"c{hash_seed}.tsv").read_text(), (tmp_path / f"c{hash_seed}.counts.tsv").read_text(),
                        o.read_bytes()))
    assert outputs[0] == outputs[1]
    head, *rows = outputs[0][0].splitlines()
    assert "read_site_key" in head.split("\t") and len(rows) > 50
    session = json.loads((tmp_path / "s1.json").read_text())
    assert session["frontend"]["metaLocus"]["seed"] == 1 and session["viewport"]["chrom"].startswith("meta:")

    # 3. Quantify the re-clustered session's window, with the metaprofile.
    q = tmp_path / "q.tsv"
    _cli(tmp_path, "quantify", str(tmp_path / "s1.json"), "--out", str(q), "--window", "-200,50",
         "--measures", "layer:nuc,layer:tf", "--value", "enrichment", "--profile", str(tmp_path / "p.tsv"))
    lines = [line for line in q.read_text().splitlines() if not line.startswith("#")]
    assert lines[0].split("\t")[:4] == ["measure", "source", "unit", "group"] and len(lines) == 1 + 2 * 3
    qr = json.loads((tmp_path / "q.tsv.receipt.json").read_text())
    assert qr["meta_locus"]["seed"] == 1 and qr["quantify"]["read_source"] == "panel"
    assert qr["quantify"]["bounds"]["kind"] == "window" and qr["profile"]["bins"] == 500
    prof = (tmp_path / "p.tsv").read_text().splitlines()
    assert prof[1].split("\t")[:5] == ["group", "channel", "bin", "rel_start", "rel_end"]

    # 4. By spec, straight from the BED (no session): the CLI's table equals the client's.
    q2 = tmp_path / "q2.tsv"
    _cli(tmp_path, "quantify", *pool, "--out", str(q2), "--window", "-200,50", "--measures", "layer:nuc",
         "--no-receipt")
    sys.path.insert(0, str(REPO))
    from browser_client import BrowserClient
    from port_list import free_test_port
    os.environ.setdefault("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "mlcache"))
    with BrowserClient.headless(dataset=[f"{DEMO}:demo"], port=free_test_port(), timeout=120) as client:
        reply = client.quantify_window({"meta_locus": {"bed": str(bed), "anchor": "start", "flank_bp": 1500},
                                        "seed": 1, "count": 300, "window": [-200, 50]}, measures=["layer:nuc"], seed=1)
        fig, man = client.figure(meta_locus={"bed": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 1,
                                             "count": 300}, format="svg", return_manifest=True, manifest_read_ids=True)
    strip = lambda text: [line for line in text.splitlines() if not line.startswith("#")]  # noqa: E731
    assert strip(q2.read_text()) == strip(reply["tsv"])
    assert man["meta_locus"]["spec_hash"] == ml["spec_hash"]
    assert sorted(man["panels"][0]["read_ids"]) == sorted(receipt["manifest"]["panels"][0]["read_ids"])

    # 5. A missing BED fails before any server starts, naming it.
    bad = _cli(tmp_path, "render", "--bed", str(tmp_path / "gone.bed"), "--anchor", "start", "--bam", str(DEMO),
               "--out", str(tmp_path / "x.pdf"), ok=False)
    assert bad.returncode == 2 and "gone.bed" in bad.stderr
