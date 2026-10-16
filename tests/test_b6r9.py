"""Other analyses, review round 9 (B6): primer BLAST hints, APA O/E, empty read
scopes, dataset-aware annotation frames, co-accessibility cache keys, DAF-C
effective resolution and atomic ChIP-Atlas downloads."""
import asyncio
import io
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "browser"))
sys.path.insert(0, str(ROOT))


# 1. An explicit primer FASTA decides which BLAST database matches.
def test_explicit_primer_fasta_keeps_its_blast_database(tmp_path):
    from services.primer_config import genome_hints, resolve_blast_db_for_genome

    for name in ("custom", "hg38"):
        (tmp_path / f"{name}.nin").write_bytes(b"x")
        (tmp_path / f"{name}.nsq").write_bytes(b"x")
    state = SimpleNamespace(current_genome="hg38", fasta_path="/ref/hg38.fa",
                            primer_fasta="/ref/custom.fa", primer_blast_db=str(tmp_path / "custom"))
    assert genome_hints(state) == ["custom"]
    db, error = resolve_blast_db_for_genome(state)
    assert error is None and db == str(tmp_path / "custom")

    # Without an override the loaded genome still decides.
    state = SimpleNamespace(current_genome="hg38", fasta_path="/ref/hg38.fa",
                            primer_fasta=None, primer_blast_db=str(tmp_path / "custom"))
    db, error = resolve_blast_db_for_genome(state)
    assert db == str(tmp_path / "hg38") and error is None


# 2. APA with a cold expected cache computes it; it never labels raw counts O/E.
def _apa(monkeypatch, expected):
    import routers.microc as microc
    from models.requests import APAPeaks

    seen = {}

    def fake_expected(chrom, res, allow_compute=False, dafc_state=None, **_kw):
        seen["allow_compute"] = allow_compute
        return expected if allow_compute else None

    def fake_apa(matrix, peaks, resolution, window, chrom_nbins, expected_per_dist=None):
        seen["expected"] = expected_per_dist
        return {"matrix": np.ones((3, 3)), "apa_score": 1.0, "center_value": 1.0,
                "corner_mean": 1.0, "n_pairs": 1, "matrix_size": 3}

    clr = SimpleNamespace(extent=lambda c: (0, 100), chromsizes={"chr1": 100_000})
    state = SimpleNamespace(clr=clr, chrom_expected_cache={}, current_resolution=1000, resolutions=[1000])
    monkeypatch.setattr(microc, "_load_cooler_module", lambda: object())
    monkeypatch.setattr(microc, "_resolve_cooler_chrom", lambda st, c: c)
    monkeypatch.setattr(microc, "cooler_at_resolution", lambda st, r, m: (st, 1000))
    monkeypatch.setattr(microc, "compute_chrom_expected", fake_expected)
    import services.microc_apa as apa_mod
    monkeypatch.setattr(apa_mod, "CoolerWindows", lambda *a, **k: object())
    monkeypatch.setattr(microc, "compute_apa_from_matrix", fake_apa)
    peaks = APAPeaks(peaks=[{"start": 1000, "end": 2000}, {"start": 5000, "end": 6000}])
    out = asyncio.run(microc.compute_apa(peaks, chrom="chr1", window=3000, resolution=None,
                                         normalization="oe", dafc_state=state))
    return out, seen


def test_apa_computes_cold_expected_for_oe(monkeypatch):
    out, seen = _apa(monkeypatch, np.ones(50))
    assert seen["allow_compute"] is True
    assert seen["expected"] is not None
    assert out["normalization"] == "oe" and "warning" not in out


def test_apa_reports_raw_counts_when_expected_is_unavailable(monkeypatch):
    out, seen = _apa(monkeypatch, None)
    assert seen["expected"] is None
    assert out["normalization"] == "none" and out["warning"]


# 3. An explicit empty read selection stays empty in client requests.
class _Client:
    def __init__(self):
        from browser_client import BrowserClient
        self.cls = BrowserClient

    def make(self):
        client = self.cls.__new__(self.cls)
        client.get_datasets = lambda: [{"id": "A"}, {"id": "B"}]
        return client


def test_empty_read_ids_become_an_empty_scope_per_dataset():
    client = _Client().make()
    params = {"dataset_ids": "A"}
    client._add_read_scope_params(params, [], None)
    assert "read_ids" not in params
    assert json.loads(params["read_ids_by_dataset"]) == {"A": []}

    params = {}
    client._add_read_scope_params(params, [], None)
    assert json.loads(params["read_ids_by_dataset"]) == {"A": [], "B": []}

    params = {}
    client._add_read_scope_params(params, None, None)
    assert params == {}


def test_empty_read_scope_computes_no_reads():
    from services.analysis_query import AnalysisReadQuery
    from services.coaccessibility_endpoint import _parse_read_ids_by_dataset

    scoped = _parse_read_ids_by_dataset(json.dumps({"A": []}))
    query = AnalysisReadQuery(chrom="chr1", start=0, end=100, dataset_ids=["A"], read_ids_by_dataset=scoped)
    assert query.filter_reads_for_dataset("A", [{"id": "r1"}]) == []


# 4. Annotation DataFrames keep which dataset each molecule is from.
def test_annotation_frame_keeps_dataset_identity():
    client = _Client().make()
    client.get_region = lambda: {"chrom": "chr1", "start": 0, "end": 100}
    client._get = lambda endpoint, params=None: {
        "annotations": {"r1": [{"type": "X", "start": 1, "end": 2, "confidence": 1.0},
                               {"type": "Y", "start": 3, "end": 4, "confidence": 1.0}]},
        "annotations_by_dataset": {
            "A": {"r1": [{"type": "X", "start": 1, "end": 2, "confidence": 1.0}]},
            "B": {"r1": [{"type": "Y", "start": 3, "end": 4, "confidence": 1.0}]},
        },
    }
    frame = client.get_annotations()
    rows = sorted(zip(frame["dataset_id"], frame["read_name"], frame["type"]))
    assert rows == [("A", "r1", "X"), ("B", "r1", "Y")]


# 5. The co-accessibility cache key covers legacy layer inference.
def test_coacc_cache_key_includes_legacy_inference():
    from services.analysis_query import AnalysisReadQuery
    from services.coaccessibility_endpoint import _coacc_matrix_cache_key

    state = SimpleNamespace(datasets={}, get_dataset=lambda _d: None, quality_filters=[])
    keys = []
    for size in (90, 120):
        query = AnalysisReadQuery(chrom="chr1", start=0, end=100, dataset_ids=["A"], legacy_nuc_min_size=size)
        scope = SimpleNamespace(query=query, bin_size=10)
        keys.append(_coacc_matrix_cache_key(state, scope, "raw", 1, "nucleosome", None))
    assert keys[0] != keys[1]


# 6. An O/E image at a resolution the file lacks uses the loaded resolution.
def test_dafc_oe_image_uses_the_effective_resolution(monkeypatch):
    import routers.dafc as dafc
    from services.microc_matrix import apply_distance_expected, local_expected_per_distance

    counts = np.array([[10.0, 20.0], [30.0, 40.0]])
    captured = {}
    clr = SimpleNamespace(chromsizes={"chr1": 10_000})
    state = SimpleNamespace(clr=clr, current_resolution=1000, resolutions=[1000], cool_file="a.cool")
    monkeypatch.setattr(dafc, "_load_cooler_modules", lambda: (object(), object()))
    monkeypatch.setattr(dafc, "fetch_cooler_matrix", lambda *a, **k: counts.copy())

    class _Img:
        def save(self, buf, format):
            buf.write(b"png")

    def render(matrix, **_kw):
        captured["matrix"] = matrix
        return _Img()

    monkeypatch.setattr(dafc, "render_contact_matrix_image", render)
    asyncio.run(dafc.dafc_matrix_image(chrom="chr1", start=0, end=None, resolution=5000,
                                       x_start=0, x_end=2000, y_start=1000, y_end=3000,
                                       scaling="linear", colormap="fall", normalization="oe",
                                       vmin=None, vmax=None, dafc_state=state))
    origins = dict(row_origin=1, col_origin=0)
    expected = apply_distance_expected(counts.copy(), local_expected_per_distance(counts.copy(), max_dist=None, **origins),
                                       invalid_fill="matrix", **origins)
    np.testing.assert_allclose(captured["matrix"], np.nan_to_num(expected))


# 7. An interrupted ChIP-Atlas download leaves no cache behind.
def test_interrupted_chipatlas_download_leaves_no_cache(tmp_path, monkeypatch):
    from services import external_chipatlas as ca

    monkeypatch.setattr(ca, "chipatlas_data_dir", lambda: str(tmp_path))

    class _Resp:
        headers = {"Content-Length": "100"}

        def __init__(self):
            self.calls = 0

        def read(self, _n):
            self.calls += 1
            if self.calls == 1:
                return b"E1\tdm6\tTFs\tPol\tembryo\t2h\n"
            raise TimeoutError("timed out")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ca.urllib.request, "urlopen", lambda req, timeout=0: _Resp())
    ca.load_chipatlas_metadata_sync()
    assert ca.chipatlas_load_progress["status"] == "error"
    assert not os.path.exists(tmp_path / "experimentList.tab")
    assert not list(tmp_path.glob("*.part-*"))


def test_complete_chipatlas_download_is_moved_into_place(tmp_path, monkeypatch):
    from services import external_chipatlas as ca

    monkeypatch.setattr(ca, "chipatlas_data_dir", lambda: str(tmp_path))
    body = b"E1\tdm6\tTFs\tPol\tembryo\t2h\n"

    class _Resp(io.BytesIO):
        headers = {"Content-Length": str(len(body))}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ca.urllib.request, "urlopen", lambda req, timeout=0: _Resp(body))
    ca.load_chipatlas_metadata_sync()
    assert ca.chipatlas_load_progress["status"] == "ready"
    assert (tmp_path / "experimentList.tab").read_bytes() == body
    assert ca.chipatlas_metadata["dm6"][0]["id"] == "E1"
