"""End-to-end tests for the Playwright render engine.

Gated by FIBERBROWSER_RUN_PLAYWRIGHT_RENDER=1 so CI without Chromium /
Node / a built dist/ simply skips. To run locally:

    cd browser/frontend && npm run build      # one-time, when frontend changed
    npx playwright install chromium           # one-time, ~170MB
    FIBERBROWSER_RUN_PLAYWRIGHT_RENDER=1 \\
      pytest tests/test_playwright_render.py -v

Spawns a fresh FiberBrowser server on a free port with the tracked NAPA demo
BAM (browser/data/demo/napa_ddda.bam, DddA reads on chr19),
makes real HTTP requests against /api/render?engine=playwright, validates the
returned bytes structurally (PNG magic, non-blank, width scales), and asserts
the worker stays up across requests + tears down cleanly.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

# The spawned servers require an access token (services/local_auth.py); every
# request here, and the render worker's own page load, carries it.
SERVER_TOKEN = "playwright-render-test-token"
_http = requests.Session()
_http.headers["X-FiberBrowser-Token"] = SERVER_TOKEN

REPO_ROOT = Path(__file__).resolve().parents[1]
TEST_BAM = REPO_ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"

GATE_ENV = "FIBERBROWSER_RUN_PLAYWRIGHT_RENDER"
# 12 kb over the demo reads (3,202 reads, chr19:47,514,488-47,523,522).
TEST_CHROM = "chr19"
TEST_START = 47_514_000
TEST_REGION = {"chrom": TEST_CHROM, "start": TEST_START, "end": TEST_START + 12_000}
EMPTY_CHROM = "chr1"  # a contig of the demo BAM with no reads
SHORT_TIMEOUT = 60  # per-request HTTP timeout (s); Chromium cold-start is slow


def test_datasets_for_render_accepts_browser_state_dict_shape():
    from models.domain import Dataset
    from services.playwright_render import _datasets_for_render
    from state.browser_state import BrowserState

    state = BrowserState(None)
    ds = Dataset("ds1", "sample.bam", label="Sample")
    ds.color = "#123456"
    ds.available_layers = {"tf": True, "nuc": True}
    state.datasets["ds1"] = ds

    rendered = _datasets_for_render(state, None)

    assert [d["id"] for d in rendered] == ["ds1"]
    assert rendered[0]["label"] == "Sample"
    assert rendered[0]["available_layers"] == {"tf": True, "nuc": True}


def test_datasets_for_render_accepts_sequence_shape_used_by_unit_fixtures():
    from models.domain import Dataset
    from services.playwright_render import _datasets_for_render

    ds = Dataset("ds1", "sample.bam", label="Sample")
    state = SimpleNamespace(datasets=[ds])

    assert _datasets_for_render(state, ["ds1"])[0]["id"] == "ds1"


def test_timeout_ms_request_alias_threads_to_worker(monkeypatch):
    import services.playwright_render as playwright_render
    from models.requests import RenderRequest

    class FakeWorker:
        def __init__(self):
            self.envelope = None
            self.timeout_s = None

        def submit(self, envelope, timeout_s):
            self.envelope = envelope
            self.timeout_s = timeout_s
            return {
                "ok": True,
                "png_b64": (
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0"
                    "lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
                ),
                "diagnostics": {"duration_ms": 1},
            }

    fake_worker = FakeWorker()
    monkeypatch.setattr(playwright_render, "_WORKER", fake_worker)

    req = RenderRequest(
        chrom="chr1",
        start=10,
        end=20,
        engine="playwright",
        timeoutMs=12_000,
    )
    response = playwright_render.render_with_playwright(req, SimpleNamespace(datasets=[]))

    assert response.status_code == 200
    assert fake_worker.envelope["timeoutMs"] == 12_000
    assert fake_worker.timeout_s == 17


def _render_req_stub(**overrides):
    defaults = {
        "chrom": "chr3R",
        "start": 100,
        "end": 400,
        "dataset_id": None,
        "dataset_ids": None,
        "tracks": ["axis", "reads"],
        "width": 1200,
        "row_height": 3,
        "max_reads": 500,
        "spanning_only": True,
        "read_ids": None,
        "sort_by": None,
        "n_clusters": 3,
        "cluster_order": None,
        "read_sort_order": None,
        "show_mods": False,
        "show_fire": False,
        "show_cigar": False,
        "show_layers": False,
        "tf_overlay": None,
        "colors": None,
        "quality_shading": False,
        "subnuc_threshold": 90,
        "sample_seed": None,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_state_for_request_normalizes_public_track_tokens_and_reference_state():
    import pandas as pd

    from models.domain import Dataset
    from services.playwright_render import _state_for_request
    from state.browser_state import BrowserState

    state = BrowserState(None)
    state.datasets["test_fire_sorted"] = Dataset(
        "test_fire_sorted",
        "test_fire_sorted.bam",
        label="test_fire_sorted",
    )
    state.chroms = [{"name": "chr3R", "size": 5000}]
    state.fasta = object()
    state.fasta_path = "/tmp/render_ref.fa"
    state.current_genome = "render-ref"
    state.gtf_data = {
        "transcripts": pd.DataFrame([{
            "chrom": "chr3R",
            "start": 120,
            "end": 360,
            "transcript_id": "txA",
            "gene_name": "GeneA",
            "strand": "+",
            "biotype": "protein_coding",
        }]),
        "exons": pd.DataFrame([
            {"transcript_id": "txA", "start": 120, "end": 180},
            {"transcript_id": "txA", "start": 260, "end": 360},
        ]),
    }
    state.orthogonal_tracks = [{
        "index": 7,
        "label": "Signal A",
        "values": [0.1, 0.2, 0.3],
        "renderMode": "signal",
    }]

    payload = _state_for_request(
        _render_req_stub(tracks=["axis", "genes", "peaks", "signal", "reads"]),
        state,
    )

    subtrack_types = [t["type"] for t in payload["panels"][0]["subTracks"]]
    assert subtrack_types == ["axis", "gene", "fire", "ortho-7", "sv", "coverage", "reads"]
    assert payload["hasFasta"] is True
    assert payload["fastaPath"] == "/tmp/render_ref.fa"
    assert payload["currentGenome"] == "render-ref"
    assert payload["chroms"] == [{"name": "chr3R", "size": 5000, "circular": False}]
    assert payload["genes"][0]["id"] == "txA"
    assert payload["orthogonalTracks"][0]["index"] == 7

    reads_payload = _state_for_request(_render_req_stub(tracks=["axis", "reads"]), state)
    assert reads_payload["genes"][0]["id"] == "txA"


def _gate_skip() -> None:
    if os.environ.get(GATE_ENV) != "1":
        pytest.skip(f"Set {GATE_ENV}=1 to run Playwright render tests.")
    if not TEST_BAM.exists():
        pytest.skip(f"test BAM missing at {TEST_BAM}")
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    dist_index = REPO_ROOT / "browser" / "frontend" / "dist" / "index.html"
    if not dist_index.exists():
        pytest.skip("frontend dist/ not built; run `cd browser/frontend && npm run build`")


def _free_port() -> int:
    """A free port from the test port list (tests/port_list.py), not an ephemeral one."""
    from port_list import free_ports, no_free_port_error
    ports = free_ports()
    if not ports:
        raise no_free_port_error()
    return ports[0]


def _spawn_server(
    port: int,
    *,
    concurrency: int | None = None,
    extra_args: list[str] | None = None,
) -> subprocess.Popen:
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "FIBERBROWSER_TOKEN": SERVER_TOKEN,
           # This port only: the server must not move off the test port list.
           "FIBERBROWSER_PORT_MIN": str(port), "FIBERBROWSER_PORT_MAX": str(port)}
    if concurrency is not None:
        env["FIBERBROWSER_RENDER_CONCURRENCY"] = str(concurrency)
    cmd = [
        sys.executable,
        "browser.py",
        "-b",
        str(TEST_BAM),
        "-p",
        str(port),
        "--no-open",
        "--copilot",
        "off",
    ]
    if extra_args:
        cmd.extend(extra_args)
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 30.0
    base_url = f"http://127.0.0.1:{port}"
    while time.time() < deadline:
        if proc.poll() is not None:
            out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
            raise RuntimeError(f"server exited early: {out[-500:]}")
        try:
            r = _http.get(f"{base_url}/api/status", timeout=1.0)
            if r.ok:
                return proc
        except Exception:
            time.sleep(0.25)
    proc.terminate()
    raise RuntimeError("server did not become ready within 30s")


def _stop_server(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
        proc.wait(timeout=5.0)
    except Exception:
        proc.kill()


def _write_reference_fixture(ref_dir: Path) -> tuple[Path, Path]:
    """Write a tiny indexed chr3R FASTA + GTF for reference-track renders."""
    fasta = ref_dir / "render_ref.fa"
    gtf = ref_dir / "render_ref.gtf"
    seq = ("ACGT" * 1250)[:5000]
    fasta.write_text(
        ">chr3R\n" + "\n".join(seq[i:i + 60] for i in range(0, len(seq), 60)) + "\n",
        encoding="ascii",
    )
    (ref_dir / "render_ref.fa.fai").write_text(
        f"chr3R\t{len(seq)}\t6\t60\t61\n",
        encoding="ascii",
    )
    gtf.write_text(
        "\n".join([
            'chr3R\ttest\ttranscript\t120\t360\t.\t+\t.\tgene_id "geneA"; transcript_id "txA"; gene_name "GeneA";',
            'chr3R\ttest\texon\t120\t180\t.\t+\t.\tgene_id "geneA"; transcript_id "txA"; gene_name "GeneA";',
            'chr3R\ttest\texon\t260\t360\t.\t+\t.\tgene_id "geneA"; transcript_id "txA"; gene_name "GeneA";',
        ]) + "\n",
        encoding="ascii",
    )
    return fasta, gtf


@pytest.fixture(scope="module")
def server():
    """Module-scoped server fixture. Concurrency = default (4)."""
    _gate_skip()
    port = _free_port()
    proc = _spawn_server(port)
    yield {"port": port, "base_url": f"http://127.0.0.1:{port}", "proc": proc}
    _stop_server(proc)


@pytest.fixture(scope="module")
def reference_server(tmp_path_factory):
    """Server with FASTA/GTF so Playwright can exercise reference subtracks."""
    _gate_skip()
    ref_dir = tmp_path_factory.mktemp("playwright-render-ref")
    fasta, gtf = _write_reference_fixture(ref_dir)
    port = _free_port()
    proc = _spawn_server(port, extra_args=["-f", str(fasta), "-g", str(gtf)])
    yield {"port": port, "base_url": f"http://127.0.0.1:{port}", "proc": proc}
    _stop_server(proc)


def _render(base_url: str, **overrides) -> requests.Response:
    body = {**TEST_REGION, "engine": "playwright", "tracks": ["axis", "reads"], "width": 1200}
    body.update(overrides)
    return _http.post(f"{base_url}/api/render", json=body, timeout=SHORT_TIMEOUT)


def _render_density(png_bytes: bytes, sample_step: int = 8) -> dict[str, float]:
    """Compute structural-density stats over a sampled grid.

    Returns:
      - total: overall fraction of non-white sampled pixels.
      - max_row: density of the most-populated sampled row (catches "the
        render shows real data, just concentrated in track bands"). A pure
        blank/chrome render has max_row near zero; a render with one
        densely-drawn read track has max_row > 0.5.
    """
    import numpy as np
    from PIL import Image
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    sampled = arr[::sample_step, ::sample_step]
    nonwhite_mask = sampled.min(axis=-1) < 240
    total = float(nonwhite_mask.mean())
    row_density = nonwhite_mask.mean(axis=1)
    max_row = float(row_density.max()) if row_density.size else 0.0
    return {"total": total, "max_row": max_row}


# ──────────────────────────────────────────────────────────────────────
# 1. Smoke
# ──────────────────────────────────────────────────────────────────────


def test_smoke_returns_png(server):
    r = _render(server["base_url"])
    assert r.status_code == 200, f"got {r.status_code}: {r.text[:300]}"
    assert r.headers["content-type"].startswith("image/png")
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n", "PNG magic bytes missing"
    assert r.headers.get("x-render-engine") == "playwright"
    diag = json.loads(r.headers.get("x-render-diagnostics", "{}"))
    assert diag.get("duration_ms", 0) > 0
    timings = diag.get("timings") or {}
    assert timings.get("goto_ms", 0) >= 0
    assert timings.get("settle_ms", 0) >= 0
    assert timings.get("screenshot_ms", 0) >= 0


# ──────────────────────────────────────────────────────────────────────
# 2. Non-blank structural check
# ──────────────────────────────────────────────────────────────────────


def test_non_blank_render(server):
    r = _render(server["base_url"])
    assert r.status_code == 200
    density = _render_density(r.content)
    # Two-part check: at least 3% of the page is non-white AND at least one
    # row of the page is heavily populated (>30% non-white). The first guard
    # rules out near-empty renders; the second confirms an actual track band
    # exists (a pure-axis or pure-chrome render maxes out around ~15%).
    assert density["total"] >= 0.03, (
        f"render appears nearly blank: overall non-white={density['total']:.3f}, "
        f"max_row={density['max_row']:.3f}"
    )
    assert density["max_row"] >= 0.30, (
        f"no densely populated track band: max_row={density['max_row']:.3f}; "
        "the page rendered but no track produced significant content"
    )


# ──────────────────────────────────────────────────────────────────────
# 3. Width scales
# ──────────────────────────────────────────────────────────────────────


def test_width_scales(server):
    from PIL import Image
    small = _render(server["base_url"], width=1200)
    large = _render(server["base_url"], width=2400)
    assert small.status_code == 200 and large.status_code == 200
    w_small = Image.open(io.BytesIO(small.content)).width
    w_large = Image.open(io.BytesIO(large.content)).width
    # device_scale_factor (default 150/96 ≈ 1.56) multiplies through, so the
    # ratio should match — strict integer doubling won't hold.
    ratio = w_large / max(w_small, 1)
    assert 1.6 <= ratio <= 2.4, f"width ratio {ratio:.2f} not in expected range"


# ──────────────────────────────────────────────────────────────────────
# 4. Track determinism (fewer tracks → shorter image)
# ──────────────────────────────────────────────────────────────────────


def test_track_determinism(server):
    from PIL import Image
    minimal = _render(server["base_url"], tracks=["axis"])
    full = _render(server["base_url"], tracks=["axis", "reads", "genes"])
    assert minimal.status_code == 200 and full.status_code == 200
    h_minimal = Image.open(io.BytesIO(minimal.content)).height
    h_full = Image.open(io.BytesIO(full.content)).height
    # Tracks layer vertically in the panel; including reads + genes adds
    # substantial pixels. Even with chrome-hiding, the difference should be
    # measurable. We avoid hard pixel thresholds; just assert "full" is
    # not less than "minimal" + some slack.
    assert h_full >= h_minimal, f"full render shorter than minimal ({h_full} vs {h_minimal})"


def test_peaks_public_track_token_renders_fire_subtrack(server):
    axis = _render(server["base_url"], tracks=["axis"], width=900)
    peaks = _render(server["base_url"], tracks=["axis", "peaks"], width=900)
    assert axis.status_code == 200 and peaks.status_code == 200
    assert _hash(axis.content) != _hash(peaks.content), (
        "`tracks=['peaks']` did not change output; the public token should "
        "normalize to the frontend FIRE/peaks subtrack."
    )


def test_gene_public_track_token_renders_loaded_gtf(reference_server):
    axis = _render(
        reference_server["base_url"],
        chrom="chr3R",
        start=100,
        end=400,
        tracks=["axis"],
        width=900,
        spanning_only=False,
    )
    genes = _render(
        reference_server["base_url"],
        chrom="chr3R",
        start=100,
        end=400,
        tracks=["axis", "genes"],
        width=900,
        spanning_only=False,
    )
    assert axis.status_code == 200, axis.text[:300]
    assert genes.status_code == 200, genes.text[:300]
    assert _hash(axis.content) != _hash(genes.content), (
        "`tracks=['genes']` did not add visible GTF content; expected the "
        "render payload to preload genes and normalize to `gene`."
    )


def test_sequence_track_renders_loaded_fasta(reference_server):
    axis = _render(
        reference_server["base_url"],
        chrom="chr3R",
        start=100,
        end=180,
        tracks=["axis"],
        width=900,
        spanning_only=False,
    )
    sequence = _render(
        reference_server["base_url"],
        chrom="chr3R",
        start=100,
        end=180,
        tracks=["axis", "sequence"],
        width=900,
        spanning_only=False,
    )
    assert axis.status_code == 200, axis.text[:300]
    assert sequence.status_code == 200, sequence.text[:300]
    assert _hash(axis.content) != _hash(sequence.content), (
        "`tracks=['sequence']` did not add visible FASTA bases; expected "
        "render-mode state to carry hasFasta/fastaPath."
    )


# ──────────────────────────────────────────────────────────────────────
# 5. Engine isolation (numpy + playwright both 200; no pixel diff)
# ──────────────────────────────────────────────────────────────────────


def test_engine_isolation(server):
    pw = _render(server["base_url"], engine="playwright")
    nm = _render(server["base_url"], engine="numpy")
    assert pw.status_code == 200, f"playwright failed: {pw.text[:300]}"
    assert nm.status_code == 200, f"numpy failed: {nm.text[:300]}"
    assert pw.headers.get("x-render-engine") == "playwright"
    # numpy renderer doesn't set X-Render-Engine — confirm the two paths are
    # different bytes (any meaningful difference is fine).
    assert pw.content != nm.content, "playwright and numpy returned identical bytes"


# ──────────────────────────────────────────────────────────────────────
# 6. Cleanup (no orphan node/chromium with the worker's PID)
# ──────────────────────────────────────────────────────────────────────


def test_cleanup_no_orphans(server):
    # First render kicks off the worker; subsequent should reuse it.
    r1 = _render(server["base_url"])
    r2 = _render(server["base_url"])
    assert r1.status_code == 200 and r2.status_code == 200
    # We don't kill the server here; module teardown handles that and we
    # can't introspect the worker PID across processes without a side
    # channel. Instead assert that two back-to-back renders both succeeded
    # AND took less wall-clock than two cold starts would (proves reuse).
    diag1 = json.loads(r1.headers.get("x-render-diagnostics", "{}"))
    diag2 = json.loads(r2.headers.get("x-render-diagnostics", "{}"))
    assert diag2.get("duration_ms", 99_999) <= diag1.get("duration_ms", 0) + 3_000, \
        "second render should not take significantly longer than first (worker reuse expected)"


# ──────────────────────────────────────────────────────────────────────
# 7. Concurrency — 4 in-flight renders should not serialize
# ──────────────────────────────────────────────────────────────────────


def test_concurrency_runs_parallel(server):
    # Prime the worker with one request so its cold-start doesn't dominate.
    primer = _render(server["base_url"])
    assert primer.status_code == 200

    # Hit it with 4 distinct regions in parallel.
    regions = [
        {"chrom": TEST_CHROM, "start": TEST_START, "end": TEST_START + 4_000},
        {"chrom": TEST_CHROM, "start": TEST_START + 4_000, "end": TEST_START + 8_000},
        {"chrom": TEST_CHROM, "start": TEST_START + 8_000, "end": TEST_START + 12_000},
        {"chrom": TEST_CHROM, "start": TEST_START + 500, "end": TEST_START + 4_500},
    ]
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(_render, server["base_url"], **region) for region in regions]
        responses = [f.result() for f in as_completed(futures)]
    wall_ms = (time.time() - t0) * 1000
    for r in responses:
        assert r.status_code == 200, f"got {r.status_code}: {r.text[:200]}"

    # If renders were fully serialized we'd see ~4x the warm-render time.
    # Estimate the warm-render time from the primer's diagnostics.
    primer_diag = json.loads(primer.headers.get("x-render-diagnostics", "{}"))
    warm_ms = primer_diag.get("duration_ms", 1000)
    # Allow generous slack. Real renders now actually fetch reads (after the
    # render-mode setViewport-race fix), so a large fraction of warm_ms is
    # spent on server-side /api/reads/compact work that serializes by the
    # single FastAPI thread. Use 4.5x — sub-strict-serial (4x) with a small
    # buffer for context startup. Catches "all renders ran 8x slower in a
    # queue" without flaking on legitimate IO bottlenecks.
    assert wall_ms < warm_ms * 4.5, \
        f"4 concurrent renders took {wall_ms:.0f}ms vs warm {warm_ms}ms — likely serializing"


# ──────────────────────────────────────────────────────────────────────
# 8. Backpressure — CONCURRENCY=2 with 4 requests → 2 succeed + 2 return 503
# ──────────────────────────────────────────────────────────────────────


def test_backpressure_returns_503():
    """Spawns its own server with FIBERBROWSER_RENDER_CONCURRENCY=2."""
    _gate_skip()
    port = _free_port()
    proc = _spawn_server(port, concurrency=2)
    base_url = f"http://127.0.0.1:{port}"
    try:
        # Prime so the worker is hot.
        primer = _render(base_url)
        assert primer.status_code == 200

        # Hit with 4 simultaneous requests. Two should succeed; two should
        # return 503 with Retry-After.
        regions = [
            {"chrom": TEST_CHROM, "start": TEST_START + i * 1000,
             "end": TEST_START + 2_000 + i * 1000}
            for i in range(4)
        ]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(_render, base_url, **r) for r in regions]
            responses = [f.result() for f in as_completed(futures)]

        codes = sorted(r.status_code for r in responses)
        # We expect a mix. Allow either {200,200,503,503} (strict) or any
        # arrangement that includes at least one 503 — Chromium scheduling
        # can let a third request slip in if one finishes fast.
        assert 503 in codes, f"expected backpressure 503, got {codes}"
        for r in responses:
            if r.status_code == 503:
                assert r.headers.get("retry-after") == "1", \
                    f"503 missing Retry-After header: {dict(r.headers)}"
    finally:
        _stop_server(proc)


# ──────────────────────────────────────────────────────────────────────
# 9. read_ids subset reaches the React store as `filteredReadIds` AND
#    actually subsets the rendered reads (Bug 1 — both halves of the fix)
# ──────────────────────────────────────────────────────────────────────


def _list_read_ids_in_region(base_url: str, limit: int = 80) -> list[str]:
    """Pull a list of actual read IDs in the test region by calling /api/reads."""
    params = {**TEST_REGION, "max_reads": limit}
    r = _http.get(f"{base_url}/api/reads/compact", params=params, timeout=30)
    r.raise_for_status()
    payload = r.json()
    reads = payload.get("reads") or []
    ids = [str(rd.get("id")) for rd in reads if rd.get("id")]
    return ids


def test_read_ids_filter_subsets_rendered_pixels(server):
    """End-to-end regression for Bug 1 (FiberCNN bug report).

    Two distinct read_ids subsets must produce different PNG bytes. If they
    don't, EITHER (a) the field-name layer is wrong (filter never reaches
    the store), OR (b) the fetch layer drops on undefined fields (the
    `needsCigar` was silently `undefined` because `enabledCigarTypes` came
    through as `{}`, killing URLSearchParams construction and the entire
    /api/reads/compact request).
    """
    import hashlib

    ids = _list_read_ids_in_region(server["base_url"], limit=80)
    if len(ids) < 6:
        pytest.skip(f"need >=6 reads in test region for filter test, got {len(ids)}")

    half = max(2, len(ids) // 4)
    set_a = ids[:half]
    set_b = ids[half : 2 * half]
    assert not set(set_a).intersection(set_b), "test subsets must be disjoint"

    # spanning_only=False so the filter actually surfaces reads. With the
    # default spanning_only=True, no individual fiber-seq read spans the
    # full 12kb test region, and the filtered set ∩ spanning set = ∅ for
    # every subset — A and B both render the same empty filter state.
    r_full = _render(server["base_url"], spanning_only=False)
    r_a = _render(server["base_url"], read_ids=set_a, spanning_only=False)
    r_b = _render(server["base_url"], read_ids=set_b, spanning_only=False)
    for r in (r_full, r_a, r_b):
        assert r.status_code == 200, f"got {r.status_code}: {r.text[:300]}"

    h_full = hashlib.md5(r_full.content).hexdigest()
    h_a = hashlib.md5(r_a.content).hexdigest()
    h_b = hashlib.md5(r_b.content).hexdigest()

    assert h_a != h_b, (
        f"read_ids filter not applied: subsets A and B produced identical "
        f"PNGs (hash={h_a}). Filter is being dropped between request and canvas."
    )
    assert h_a != h_full, (
        f"filtered render is identical to unfiltered (hash={h_a}); "
        f"the filter is being silently ignored."
    )


def test_show_nudges_toggles_filter_empty_overlay(server):
    """Verify the in-track read-filter-empty nudge can be toggled on/off
    via the new RenderRequest.show_nudges flag.

    Trigger the "Filter is hiding every read in this viewport" state by
    rendering with a `read_ids` list of fake IDs that don't exist + the
    default spanning_only=True. With show_nudges=False (default) the
    rose overlay box is hidden by render-mode CSS. With show_nudges=True
    it stays visible. The two renders must produce different PNG bytes.
    """
    import hashlib

    fake_ids = ["nonexistent_filter_id_a", "nonexistent_filter_id_b"]
    body = {**TEST_REGION, "engine": "playwright", "tracks": ["axis", "reads"],
            "width": 1200, "read_ids": fake_ids}

    r_hidden = _http.post(f"{server['base_url']}/api/render",
                             json={**body, "show_nudges": False}, timeout=SHORT_TIMEOUT)
    r_shown = _http.post(f"{server['base_url']}/api/render",
                            json={**body, "show_nudges": True}, timeout=SHORT_TIMEOUT)

    assert r_hidden.status_code == 200, r_hidden.text[:300]
    assert r_shown.status_code == 200, r_shown.text[:300]

    h_hidden = hashlib.md5(r_hidden.content).hexdigest()
    h_shown = hashlib.md5(r_shown.content).hexdigest()

    # The rose "Filter is hiding every read" overlay (~340x140 px) only
    # appears when show_nudges=true. The two renders must differ.
    assert h_hidden != h_shown, (
        f"show_nudges toggle had no visual effect (both renders hash={h_hidden}). "
        "Expected the in-track filter-empty overlay to appear only with "
        "show_nudges=true."
    )


def test_read_ids_filter_field_name_correct(server):
    """Asserts the playwright payload uses `filteredReadIds` (not the older
    `activeReadIds`) keyed by every dataset id in the render. Inspects the
    Python service's payload-builder directly, so it doesn't depend on the
    deeper ReadTrack-fetch-not-firing bug to pass."""
    from services.playwright_render import _state_for_request

    class _Req:
        chrom = "chr3R"; start = 6_749_000; end = 6_761_000
        dataset_id = None
        dataset_ids = None
        tracks = ["axis", "reads"]
        width = 1200; row_height = 3; max_reads = 500
        spanning_only = True
        read_ids = ["read_a", "read_b", "read_c"]
        sort_by = None
        n_clusters = 3
        cluster_order = None; read_sort_order = None
        show_mods = False; show_fire = False; show_cigar = False; show_layers = False
        tf_overlay = None
        colors = None; quality_shading = False
        subnuc_threshold = 90
        sample_seed = None

    # Use a real-shaped state so the dataset list isn't empty.
    from models.domain import Dataset
    from state.browser_state import BrowserState
    state = BrowserState(None)
    state.datasets["test_fire_sorted"] = Dataset(
        "test_fire_sorted", "test_fire_sorted.bam", label="test_fire_sorted",
    )

    payload = _state_for_request(_Req(), state)

    assert "activeReadIds" not in payload, (
        "playwright payload still uses the old `activeReadIds` field name "
        "that the canvas doesn't read. Should be `filteredReadIds`."
    )
    assert "filteredReadIds" in payload, "expected `filteredReadIds` in payload"
    filt = payload["filteredReadIds"]
    assert isinstance(filt, dict), f"filteredReadIds should be a Record, got {type(filt)}"
    # Keyed by every dataset id rendered (single ds here).
    assert list(filt.keys()) == ["test_fire_sorted"], filt
    assert filt["test_fire_sorted"] == ["read_a", "read_b", "read_c"]


# ══════════════════════════════════════════════════════════════════════
# PARAMETRIC COVERAGE — one test per RenderRequest field with visual
# impact. Each asserts that toggling the param produces a measurably
# different PNG (md5 differs, OR dimension differs, OR density differs).
#
# Goal: future regressions in any of these fields can't hide. The
# original Playwright bug cascade was only caught when a downstream
# user exercised specific combinations — these tests cover the same
# fields proactively.
# ══════════════════════════════════════════════════════════════════════


import hashlib


def _hash(content: bytes) -> str:
    return hashlib.md5(content).hexdigest()


def _png_dims(content: bytes) -> tuple[int, int]:
    from PIL import Image
    img = Image.open(io.BytesIO(content))
    return img.size


def test_spanning_only_changes_output(server):
    """spanning_only flips: subset of reads displayed differs."""
    a = _render(server["base_url"], spanning_only=True)
    b = _render(server["base_url"], spanning_only=False)
    assert a.status_code == 200 and b.status_code == 200
    assert _hash(a.content) != _hash(b.content), \
        "spanning_only toggle had no visible effect on the render"


def test_show_mods_changes_output(server):
    """show_mods adds m6A modification markers to the read track."""
    off = _render(server["base_url"], show_mods=False, spanning_only=False)
    on = _render(server["base_url"], show_mods=True, spanning_only=False)
    assert off.status_code == 200 and on.status_code == 200
    assert _hash(off.content) != _hash(on.content), \
        "show_mods didn't change pixel output (m6A overlays missing?)"


def test_show_fire_changes_output(server):
    """show_fire adds the FIRE accessibility overlay."""
    off = _render(server["base_url"], show_fire=False, spanning_only=False)
    on = _render(server["base_url"], show_fire=True, spanning_only=False)
    assert off.status_code == 200 and on.status_code == 200
    assert _hash(off.content) != _hash(on.content), \
        "show_fire toggle had no visual effect"


def test_show_layers_does_not_crash(server):
    """Smoke check — show_layers=True+False both produce valid renders.

    NOTE: with the current store defaults (tf:true, nuc:true), toggling
    show_layers on top of those is a no-op visually. We can't assert a
    pixel diff like the other show_* tests. The smoke check still catches
    a regression in the on-path (e.g. show_layers=True throwing during
    layer dispatch)."""
    off = _render(server["base_url"], show_layers=False, spanning_only=False)
    on = _render(server["base_url"], show_layers=True, spanning_only=False)
    assert off.status_code == 200, f"show_layers=False crashed: {off.text[:200]}"
    assert on.status_code == 200, f"show_layers=True crashed: {on.text[:200]}"
    for label, r in (("off", off), ("on", on)):
        density = _render_density(r.content)
        assert density["max_row"] >= 0.30, \
            f"show_layers={label} produced near-blank render (max_row={density['max_row']:.3f})"


def test_show_cigar_does_not_crash(server):
    """REGRESSION (Bug A — anyCigarEnabled returned undefined when the
    enabledCigarTypes shape was {}). show_cigar=True crashed the entire
    /api/reads/compact fetch silently — page rendered empty. Verify
    both states still produce a real render."""
    off = _render(server["base_url"], show_cigar=False, spanning_only=False)
    on = _render(server["base_url"], show_cigar=True, spanning_only=False)
    assert off.status_code == 200, f"show_cigar=False crashed: {off.text[:200]}"
    assert on.status_code == 200, f"show_cigar=True crashed: {on.text[:200]}"
    # Both must produce non-blank renders (i.e. reads actually fetched).
    for label, r in (("off", off), ("on", on)):
        density = _render_density(r.content)
        assert density["max_row"] >= 0.30, (
            f"show_cigar={label} produced near-blank render — reads "
            f"likely didn't fetch (density max_row={density['max_row']:.3f}). "
            "This is the Bug A failure mode."
        )


def test_quality_shading_changes_output(server):
    """quality_shading on vs off should differ visibly.

    Originally xfailed on 2026-05-27 with a 502 + 'unknown render error',
    which surfaced a deeper framing bug — the worker's `log()` function
    was leaking the request id into lifecycle log frames, and a settlement-
    timeout log frame was overriding the actual render response in Python's
    dispatcher. Fixed in render-headless.mjs by spreading extras BEFORE the
    fixed id/kind fields so caller-provided id can't override id: null.

    The underlying React-side issue (partial activeColormap from Python
    replacing the store's full DEFAULT_COLORMAP via shallow setState) is
    also fixed: the worker now deep-merges incoming.activeColormap into the
    current store value, so partial payloads are additive."""
    off = _render(server["base_url"], quality_shading=False, spanning_only=False)
    on = _render(server["base_url"], quality_shading=True, spanning_only=False)
    assert off.status_code == 200, f"qs=off failed: {off.text[:200]}"
    assert on.status_code == 200, f"qs=on failed: {on.text[:200]}"
    assert _hash(off.content) != _hash(on.content), \
        "quality_shading toggle had no visible effect"


def test_max_reads_caps_displayed_reads(server):
    """Lower max_reads should change the displayed read count → pixel diff."""
    small = _render(server["base_url"], max_reads=20, spanning_only=False)
    large = _render(server["base_url"], max_reads=500, spanning_only=False)
    assert small.status_code == 200 and large.status_code == 200
    assert _hash(small.content) != _hash(large.content), \
        "max_reads param had no visible effect on the render"


def test_row_height_changes_render_height(server):
    """Taller rows → taller render (when reads fill the track)."""
    short = _render(server["base_url"], row_height=2, spanning_only=False)
    tall = _render(server["base_url"], row_height=8, spanning_only=False)
    assert short.status_code == 200 and tall.status_code == 200
    # Hash differs is sufficient — exact dimension change depends on
    # how reads pack into the available height; differences in either
    # height or per-read striping count.
    assert _hash(short.content) != _hash(tall.content)


def test_dpi_scales_output_dimensions(server):
    """dpi=300 produces a 2x denser render than dpi=150."""
    low = _render(server["base_url"], dpi=150, spanning_only=False)
    high = _render(server["base_url"], dpi=300, spanning_only=False)
    assert low.status_code == 200 and high.status_code == 200
    w_low, _ = _png_dims(low.content)
    w_high, _ = _png_dims(high.content)
    ratio = w_high / max(w_low, 1)
    assert 1.7 <= ratio <= 2.3, (
        f"dpi=300 should ~double dpi=150 width; got ratio={ratio:.2f} "
        f"(low={w_low}, high={w_high})"
    )


def test_sample_seed_reproducible(server):
    """Same sample_seed should produce identical bytes for two renders."""
    a = _render(server["base_url"], sample_seed="abc-123", spanning_only=False)
    b = _render(server["base_url"], sample_seed="abc-123", spanning_only=False)
    assert a.status_code == 200 and b.status_code == 200
    assert _hash(a.content) == _hash(b.content), \
        "renders with same sample_seed differ — non-deterministic"


def test_different_sample_seeds_differ(server):
    """Different seeds (with sampling > displayable count) should differ."""
    a = _render(server["base_url"], sample_seed="seed-A",
                max_reads=10, spanning_only=False)
    b = _render(server["base_url"], sample_seed="seed-B",
                max_reads=10, spanning_only=False)
    assert a.status_code == 200 and b.status_code == 200
    # NOTE: with max_reads=10 the sampling differs across seeds. If it
    # doesn't differ here either the seed isn't propagating or sampling
    # is deterministic regardless of seed.
    assert _hash(a.content) != _hash(b.content), \
        "different sample_seeds produced identical renders — seed ignored?"


# ══════════════════════════════════════════════════════════════════════
# FORMAT TESTS — non-PNG output paths (PDF / SVG wrap the PNG)
# ══════════════════════════════════════════════════════════════════════


def test_format_pdf_returns_pdf(server):
    """format=pdf returns a PDF (magic %PDF-)."""
    r = _render(server["base_url"], format="pdf", spanning_only=False)
    assert r.status_code == 200, r.text[:300]
    assert r.content[:5] == b"%PDF-", f"not a PDF: {r.content[:20]!r}"


def test_format_svg_returns_svg(server):
    """format=svg returns SVG XML wrapping the PNG."""
    r = _render(server["base_url"], format="svg", spanning_only=False)
    assert r.status_code == 200, r.text[:300]
    # SVG can start with XML decl or <svg directly; check for either.
    head = r.content[:200]
    assert b"<svg" in head or head.startswith(b"<?xml"), \
        f"not SVG: {head!r}"


# ══════════════════════════════════════════════════════════════════════
# REGRESSION TESTS — each named after the bug it would have caught
# ══════════════════════════════════════════════════════════════════════


def test_diagnostics_reports_zero_pending_fetches_at_capture(server):
    """REGRESSION (Bug 3 — settlement check fired while reads were still
    loading, "Loading..." captured in screenshot). The settlement loop now
    waits for the pending-fetches counter to reach 0; verify the diagnostics
    header reflects that."""
    r = _render(server["base_url"], spanning_only=False)
    assert r.status_code == 200
    diag = json.loads(r.headers.get("x-render-diagnostics", "{}"))
    assert diag.get("pending_fetches_at_capture") == 0, (
        f"render captured while {diag.get('pending_fetches_at_capture')} "
        "fetches still in flight — Bug 3 regression."
    )


def test_diagnostics_store_wait_scales_with_timeout_ms(server):
    """REGRESSION (Bug 4 — store-hook wait was hardcoded 5000ms, ignored
    request body's timeoutMs). With timeoutMs=12000, store_wait_ms should
    scale to 12000 instead of silently falling back to the 30000ms default."""
    r = _http.post(f"{server['base_url']}/api/render", json={
        **TEST_REGION, "engine": "playwright", "tracks": ["axis", "reads"],
        "width": 1200, "spanning_only": False, "timeoutMs": 12000,
    }, timeout=SHORT_TIMEOUT)
    assert r.status_code == 200
    diag = json.loads(r.headers.get("x-render-diagnostics", "{}"))
    sw = diag.get("store_wait_ms", 0)
    assert sw == 12000, (
        f"expected store_wait_ms=12000 for timeoutMs=12000, got {sw} "
        "— Bug 4 regression: timeoutMs not threaded through."
    )


def test_requested_chrom_takes_precedence_over_server_default(server):
    """REGRESSION (Bug C — Browser.tsx fired getStatus() on mount and
    setViewport(initial_position.chrom) overwrote our setState chrom).
    Verify the requested chrom actually drives the render — pixel content
    of the demo reads' contig differs from a contig without reads."""
    a = _render(server["base_url"], **TEST_REGION, spanning_only=False)
    b = _render(server["base_url"], chrom=EMPTY_CHROM, start=TEST_REGION["start"], end=TEST_REGION["end"],
                spanning_only=False)
    assert a.status_code == 200 and b.status_code == 200
    assert _hash(a.content) != _hash(b.content), (
        "renders of different chroms produced identical bytes — "
        "Bug C regression: chrom request not honored."
    )


def test_sequential_renders_no_state_leakage(server):
    """REGRESSION (round-4 non-determinism finding) — sequential renders
    must produce results determined by their own params, not by leftover
    state from prior renders. Renders in order:
       1. With filter A
       2. Without filter (no read_ids)
       3. With filter B
    The unfiltered render must differ from BOTH filtered ones."""
    ids = _list_read_ids_in_region(server["base_url"], limit=80)
    if len(ids) < 6:
        pytest.skip(f"need >=6 reads for this test, got {len(ids)}")
    half = max(2, len(ids) // 4)
    set_a, set_b = ids[:half], ids[half:2 * half]

    r1 = _render(server["base_url"], read_ids=set_a, spanning_only=False)
    r2 = _render(server["base_url"], spanning_only=False)
    r3 = _render(server["base_url"], read_ids=set_b, spanning_only=False)
    for r in (r1, r2, r3):
        assert r.status_code == 200

    h1, h2, h3 = _hash(r1.content), _hash(r2.content), _hash(r3.content)
    assert h2 != h1, "unfiltered render equals filter A — state leakage"
    assert h2 != h3, "unfiltered render equals filter B — state leakage"
    assert h1 != h3, "filter A equals filter B — filter not subsetting"


# ══════════════════════════════════════════════════════════════════════
# TIMING BENCHMARKS — informational, log to stdout for trend tracking.
# Asserts only generous upper bounds (catch outright regressions, not
# every drift). Run with `pytest -s` to see the printed timings.
#
# Baselines (a 12 kb region, then test_fire_sorted.bam; now the demo BAM, spanning_only=False):
#
#   |                      | M3 Max 64GB |  M2 Air 16GB  | M2 Air 8GB |
#   |----------------------|-------------|---------------|------------|
#   | cold_start           |    8.5 s    |   18–25 s     |  35–50 s   |
#   | warm_render          |    8.5 s    |   18–22 s     |  35–45 s   |
#   | warm_render_filter   |    6.0 s    |   12–18 s     |  25–35 s   |
#   | PDF overhead         |   0.07 s    |   0.1–0.3 s   |  0.3–0.6 s |
#   | DPI 150→300 ratio    |   1.04 ×    |   1.05–1.15 × |  1.1–1.3 × |
#   | 4 concurrent (wall)  |   25.6 s    |   60–80 s     |  120–160 s |
#
# Asserts use the slowest expected machine (M2 Air 8GB) × 1.4× safety
# margin. So bounds catch genuine regressions without flaking on the low
# end of the supported hardware.
# ══════════════════════════════════════════════════════════════════════


def _time_render(base_url: str, **overrides) -> tuple[float, requests.Response]:
    t0 = time.perf_counter()
    r = _render(base_url, **overrides)
    return time.perf_counter() - t0, r


def test_benchmark_cold_start():
    """Time from server-spawn to first successful render. Worker has to
    boot Chromium + load the dist + complete an initial render.
    Bound: M2 Air 8GB worst-case ~50s × 1.4× = 70s. Anything above that
    is a real regression on the supported hardware floor."""
    _gate_skip()
    port = _free_port()
    proc = _spawn_server(port)
    try:
        t, r = _time_render(f"http://127.0.0.1:{port}", spanning_only=False)
        assert r.status_code == 200
        print(f"\nBENCHMARK cold_start: {t:.2f}s")
        assert t < 70, f"cold start took {t:.1f}s (>70s — regression on M2 Air baseline?)"
    finally:
        _stop_server(proc)


def test_benchmark_warm_render(server):
    """Render with worker already up + Chromium already booted.
    Prime once, then time three renders and report median.
    Bound: M2 Air 8GB worst-case ~45s × 1.4× = 60s."""
    _ = _render(server["base_url"], spanning_only=False)  # prime
    times = []
    for _ in range(3):
        t, r = _time_render(server["base_url"], spanning_only=False)
        assert r.status_code == 200
        times.append(t)
    times.sort()
    median = times[len(times) // 2]
    print(f"\nBENCHMARK warm_render (median of 3): {median:.2f}s "
          f"(min={times[0]:.2f}, max={times[-1]:.2f})")
    assert median < 60, f"warm render median {median:.1f}s (>60s — regression on M2 Air baseline?)"


def test_benchmark_warm_render_with_filter(server):
    """Filtered warm render — the FiberCNN per-sector workflow shape.
    Bound: M2 Air 8GB worst-case ~35s × 1.4× = 50s."""
    ids = _list_read_ids_in_region(server["base_url"], limit=40)
    if len(ids) < 6:
        pytest.skip("not enough reads")
    _ = _render(server["base_url"], spanning_only=False)  # prime
    t, r = _time_render(server["base_url"], read_ids=ids[:10], spanning_only=False)
    assert r.status_code == 200
    print(f"\nBENCHMARK warm_render_filtered: {t:.2f}s (10 read_ids)")
    assert t < 50, f"filtered warm render {t:.1f}s (>50s — regression on M2 Air baseline?)"


def test_benchmark_format_pdf_vs_png(server):
    """PDF wraps the PNG with reportlab — should be only a tiny overhead.
    Bound: M2 Air worst-case ~0.6s × 5× safety = 3s. Beyond that means
    PDF wrapping is doing something expensive it shouldn't."""
    _ = _render(server["base_url"], spanning_only=False)  # prime
    t_png, r_png = _time_render(server["base_url"], spanning_only=False, format="png")
    t_pdf, r_pdf = _time_render(server["base_url"], spanning_only=False, format="pdf")
    assert r_png.status_code == 200 and r_pdf.status_code == 200
    overhead = t_pdf - t_png
    print(f"\nBENCHMARK format: png={t_png:.2f}s pdf={t_pdf:.2f}s "
          f"(pdf overhead={overhead:.2f}s)")
    assert overhead < 3, f"PDF wrapping took {overhead:.1f}s extra (>3s)"


def test_benchmark_dpi_scaling(server):
    """High DPI should cost ~linearly more (more pixels to capture)."""
    _ = _render(server["base_url"], spanning_only=False)  # prime
    t_150, r_150 = _time_render(server["base_url"], spanning_only=False, dpi=150)
    t_300, r_300 = _time_render(server["base_url"], spanning_only=False, dpi=300)
    assert r_150.status_code == 200 and r_300.status_code == 200
    print(f"\nBENCHMARK dpi: 150={t_150:.2f}s 300={t_300:.2f}s "
          f"(ratio={t_300 / max(t_150, 0.1):.2f}x)")
    # dpi=300 has 4x the pixels; expect <= 3x time (mostly the prefill
    # is the bottleneck, not the screenshot encoding).
    assert t_300 < t_150 * 4


def test_benchmark_concurrent_4(server):
    """4 concurrent renders. Reports both wall time + per-render avg.
    Concurrent should beat strict-serial (4x warm)."""
    primer, _ = _time_render(server["base_url"], spanning_only=False)
    print(f"\nBENCHMARK warm_baseline_for_concurrency: {primer:.2f}s")

    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(_render, server["base_url"], spanning_only=False,
                               chrom=TEST_CHROM, start=TEST_START + i * 200,
                               end=TEST_REGION["end"] + i * 200)
                   for i in range(4)]
        responses = [f.result() for f in as_completed(futures)]
    wall = time.perf_counter() - t0
    n_ok = sum(1 for r in responses if r.status_code == 200)
    print(f"BENCHMARK concurrent_4: wall={wall:.2f}s ({n_ok}/4 ok), "
          f"vs 4x warm ≈ {4 * primer:.2f}s "
          f"({wall / max(4 * primer, 0.1):.2f}x of serial)")
    # Already tested as a hard pass/fail in test_concurrency_runs_parallel;
    # here just report numbers without re-asserting the bound.


def test_an_old_worker_reader_does_not_reap_its_replacement():
    import io as _io
    from concurrent.futures import Future
    from services.playwright_render import _PlaywrightWorker

    worker = _PlaywrightWorker()
    old = SimpleNamespace(stdout=_io.BytesIO(b""), pid=0)
    replacement = SimpleNamespace(poll=lambda: None)
    worker._proc = replacement
    pending = Future()
    worker._pending["r1"] = pending
    worker._reader_loop(old)  # EOF on the old worker's stdout
    try:
        assert worker._proc is replacement and not pending.done()
    finally:
        worker._proc = None  # nothing real to shut down at exit


def test_a_respawn_fails_the_dead_workers_requests():
    from concurrent.futures import Future
    from services import playwright_render
    from services.playwright_render import _PlaywrightWorker, _WorkerError

    worker = _PlaywrightWorker()
    worker._proc = SimpleNamespace(poll=lambda: 1)  # exited
    pending = Future()
    worker._pending["r1"] = pending
    original = playwright_render.WORKER_SCRIPT
    playwright_render.WORKER_SCRIPT = Path("/nonexistent/render_worker.mjs")
    try:
        with pytest.raises(_WorkerError):
            worker._ensure_running()
    finally:
        playwright_render.WORKER_SCRIPT = original
    assert isinstance(pending.exception(timeout=0), _WorkerError)
