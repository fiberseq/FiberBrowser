"""Export data > Reads > BAM subset (POST /api/reads/export_bam, services/read_bam_subset.py)."""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"
REGION = ("chr19", 47_515_000, 47_516_000)

pytestmark = pytest.mark.skipif(not DEMO.exists(), reason="demo BAM not present")


def _region_reads(n: int) -> list[str]:
    import pysam
    names = []
    with pysam.AlignmentFile(str(DEMO)) as bam:
        for read in bam.fetch(*REGION):
            if not read.is_secondary and not read.is_supplementary and read.query_name not in names:
                names.append(read.query_name)
            if len(names) == n:
                break
    return names


@pytest.fixture
def demo_client():
    from starlette.testclient import TestClient
    import server as srv
    from services.local_auth import auth_headers
    from plugins import init_context
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    from state import runtime_state
    runtime_state.set_browser_state(srv.state)
    client = TestClient(srv.app, headers=auth_headers())
    res = client.post("/api/datasets/add", json={"path": str(DEMO), "label": "napa_ddda"})
    assert res.status_code == 200, res.text
    body = res.json()
    dataset_id = (body.get("dataset") or {}).get("id") or body.get("dataset_id")
    assert dataset_id, body
    return client, dataset_id


def test_subset_has_exactly_the_chosen_reads_with_their_tags(demo_client, tmp_path):
    import pysam
    client, dataset_id = demo_client
    names = _region_reads(5)
    res = client.post("/api/reads/export_bam", json={
        "dataset_id": dataset_id, "chrom": REGION[0], "start": REGION[1], "end": REGION[2],
        "read_ids": names + ["no_such_read"]})
    assert res.status_code == 200, res.text
    assert "attachment" in res.headers["content-disposition"] and ".bam" in res.headers["content-disposition"]
    assert res.headers["x-fiberbrowser-reads"] == "5" and res.headers["x-fiberbrowser-missing"] == "1"
    out = tmp_path / "subset.bam"
    out.write_bytes(res.content)
    with pysam.AlignmentFile(str(out)) as bam:
        records = list(bam.fetch(until_eof=True))
        assert {r.query_name for r in records} == set(names)
        starts = [(r.reference_id, r.reference_start) for r in records]
        assert starts == sorted(starts)
        assert any(pg.get("PN") == "FiberBrowser" for pg in bam.header.to_dict().get("PG", []))
    with pysam.AlignmentFile(str(DEMO)) as src:
        original = {r.query_name: r for r in src.fetch(*REGION) if r.query_name in names and not r.is_secondary and not r.is_supplementary}
    for r in records:
        if not r.is_secondary and not r.is_supplementary:
            assert r.get_tags() == original[r.query_name].get_tags()
            assert r.query_sequence == original[r.query_name].query_sequence


def test_subset_errors_are_said(demo_client):
    client, dataset_id = demo_client
    res = client.post("/api/reads/export_bam", json={"dataset_id": dataset_id, "chrom": REGION[0],
                                                     "start": REGION[1], "end": REGION[2], "read_ids": []})
    assert res.status_code == 400 and "No reads" in res.json()["error"]
    res = client.post("/api/reads/export_bam", json={"dataset_id": dataset_id, "chrom": REGION[0],
                                                     "start": REGION[1], "end": REGION[2], "read_ids": ["nope"]})
    assert res.status_code == 404
    res = client.post("/api/reads/export_bam", json={"dataset_id": dataset_id, "read_ids": ["x"]})
    assert res.status_code == 400


def test_public_mode_refuses(demo_client, monkeypatch):
    client, dataset_id = demo_client
    import services.runtime as runtime
    monkeypatch.setattr(runtime, "get_public_mode", lambda: True)
    res = client.post("/api/reads/export_bam", json={"dataset_id": dataset_id, "chrom": REGION[0],
                                                     "start": REGION[1], "end": REGION[2], "read_ids": ["x"]})
    assert res.status_code == 403


def _write_part(src_header: dict, reads, path, sample: str, lengths_bump: int = 0):
    import pysam
    header = dict(src_header)
    header["RG"] = [{"ID": "a", "SM": sample}]
    if lengths_bump:
        header["SQ"] = [{**sq, "LN": sq["LN"] + lengths_bump} for sq in header["SQ"]]
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in reads:
            seg = pysam.AlignedSegment.fromstring(read.to_string(), out.header)
            seg.set_tag("RG", "a", value_type="Z")
            out.write(seg)
    pysam.index(str(path))


def test_multi_file_dataset_keeps_each_files_read_group(tmp_path):
    """Two files of one dataset that both call their read group 'a' for other
    samples: the output keeps both apart (the second renamed, with its records),
    and is marked coordinate-sorted. Files on other references are refused."""
    import pysam
    from types import SimpleNamespace
    from services.read_bam_subset import SubsetError, write_read_subset_bam

    names = _region_reads(6)
    with pysam.AlignmentFile(str(DEMO)) as bam:
        header = bam.header.to_dict()
        reads = [r for r in bam.fetch(*REGION) if r.query_name in names and not r.is_secondary and not r.is_supplementary]
    first, second = tmp_path / "a.bam", tmp_path / "b.bam"
    _write_part(header, [r for r in reads if r.query_name in names[:3]], first, "s1")
    _write_part(header, [r for r in reads if r.query_name in names[3:]], second, "s2")
    dataset = SimpleNamespace(label="two", data_type="bam", paths=[str(first), str(second)])
    state = SimpleNamespace(get_dataset=lambda _id: dataset)
    out = tmp_path / "out.bam"
    result = write_read_subset_bam(state, "two", *REGION, names, str(out))
    assert result["reads"] == 6
    with pysam.AlignmentFile(str(out)) as bam:
        h = bam.header.to_dict()
        assert h["HD"]["SO"] == "coordinate"
        groups = {g["ID"]: g["SM"] for g in h["RG"]}
        assert groups == {"a": "s1", "a.2": "s2"}
        by_name = {r.query_name: r.get_tag("RG") for r in bam.fetch(until_eof=True)}
    assert {by_name[n] for n in names[:3]} == {"a"} and {by_name[n] for n in names[3:]} == {"a.2"}

    other = tmp_path / "c.bam"
    _write_part(header, reads[:1], other, "s3", lengths_bump=10)
    dataset.paths = [str(first), str(other)]
    with pytest.raises(SubsetError, match="other chromosomes"):
        write_read_subset_bam(state, "two", *REGION, names, str(tmp_path / "bad.bam"))


def _tiny_bam(path, reads, *, length=1000, pg=None, contig="plasmid"):
    """A BAM on one contig: reads = [(name, start, length[, PG tag])]."""
    import pysam
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": contig, "LN": length}]}
    if pg:
        header["PG"] = pg
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, start, n, *tag in sorted(reads, key=lambda r: r[1]):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name, seg.reference_id, seg.reference_start = name, 0, start
            seg.query_sequence, seg.cigarstring = "A" * n, f"{n}M"
            seg.mapping_quality = tag[1] if len(tag) > 1 else 60
            if tag and tag[0]:
                seg.set_tag("PG", tag[0], value_type="Z")
            out.write(seg)
    pysam.index(str(path))


def test_a_window_across_a_circular_contigs_origin_has_the_reads_on_both_sides(tmp_path):
    """fb-n3-export (Codex audit #13): a plasmid view across its origin
    (900-1100 on a 1,000 bp contig) exported only the reads before the seam."""
    import pysam
    from types import SimpleNamespace
    from services.read_bam_subset import write_read_subset_bam

    bam = tmp_path / "plasmid.bam"
    _tiny_bam(bam, [("before_seam", 940, 50), ("after_seam", 10, 50), ("elsewhere", 400, 50)])
    dataset = SimpleNamespace(label="p", data_type="bam", paths=[str(bam)])
    state = SimpleNamespace(get_dataset=lambda _id: dataset, circular_chroms={"plasmid": {"size": 1000}},
                            translate_chrom=lambda c: c)
    out = tmp_path / "out.bam"
    result = write_read_subset_bam(state, "p", "plasmid", 900, 1100, ["before_seam", "after_seam", "elsewhere"], str(out))
    assert result["reads"] == 2 and result["missing"] == ["elsewhere"]
    with pysam.AlignmentFile(str(out)) as f:
        assert sorted(r.query_name for r in f.fetch(until_eof=True)) == ["after_seam", "before_seam"]
    # The same window as a negative logical start (-100..100).
    result = write_read_subset_bam(state, "p", "plasmid", -100, 100, ["before_seam", "after_seam"], str(out))
    assert result["reads"] == 2 and result["records"] == 2

    # Two records alike but for their MAPQ are two records (only a record seen
    # through two windows is written once); a view longer than the contig
    # fetches it on every lap, written once.
    _tiny_bam(bam, [("before_seam", 940, 50), ("twin", 20, 30, "", 60), ("twin", 20, 30, "", 5)])
    result = write_read_subset_bam(state, "p", "plasmid", 900, 1100, ["before_seam", "twin"], str(out))
    assert result["records"] == 3
    result = write_read_subset_bam(state, "p", "plasmid", -1500, 1500, ["before_seam", "twin"], str(out))
    assert result["records"] == 3
    with pysam.AlignmentFile(str(out)) as f:
        assert sorted(r.mapping_quality for r in f.fetch(until_eof=True) if r.query_name == "twin") == [5, 60]


def test_merged_files_keep_every_files_program_lines(tmp_path):
    """fb-n3-export (Codex audit #14): a two-file dataset kept only the first
    file's @PG lines, so the second file's records pointed (PG tag) at a
    program that was not in the header, or at the first file's namesake."""
    import pysam
    from types import SimpleNamespace
    from services.read_bam_subset import write_read_subset_bam

    shared = {"ID": "minimap2", "PN": "minimap2", "VN": "2.26", "CL": "minimap2 -ax map-ont"}
    a, b = tmp_path / "a.bam", tmp_path / "b.bam"
    _tiny_bam(a, [("r1", 100, 50, "fiberhmm")], pg=[shared, {"ID": "fiberhmm", "PN": "fiberhmm", "VN": "3.0", "PP": "minimap2"}])
    _tiny_bam(b, [("r2", 120, 50, "fiberhmm")], pg=[shared, {"ID": "fiberhmm", "PN": "fiberhmm", "VN": "2.9", "PP": "minimap2"},
                                                  {"ID": "samtools", "PN": "samtools", "PP": "fiberhmm"}])
    dataset = SimpleNamespace(label="two", data_type="bam", paths=[str(a), str(b)])
    state = SimpleNamespace(get_dataset=lambda _id: dataset)
    out = tmp_path / "out.bam"
    write_read_subset_bam(state, "two", "plasmid", 0, 1000, ["r1", "r2"], str(out))
    with pysam.AlignmentFile(str(out)) as f:
        pgs = {p["ID"]: p for p in f.header.to_dict()["PG"]}
        tags = {r.query_name: r.get_tag("PG") for r in f.fetch(until_eof=True)}
    # The identical aligner line once; the other fiberhmm run under a new ID, with its chain.
    assert [i for i in pgs if i.startswith("minimap2")] == ["minimap2"]
    assert pgs["fiberhmm"]["VN"] == "3.0" and pgs["fiberhmm.2"]["VN"] == "2.9"
    assert pgs["fiberhmm.2"]["PP"] == "minimap2" and pgs["samtools"]["PP"] == "fiberhmm.2"
    assert tags == {"r1": "fiberhmm", "r2": "fiberhmm.2"}
    # FiberBrowser's line continues the first file's chain.
    fb = next(p for p in pgs.values() if p.get("PN") == "FiberBrowser")
    assert fb["PP"] == "fiberhmm"


def test_a_program_line_whose_parent_is_renamed_is_renamed_too():
    """Codex review: file B lists `child PP:parent` before its own `parent`,
    which differs from A's; B's child is another line (its chain leads to B's
    parent), not A's child."""
    from services.read_bam_subset import _merge_programs

    programs = [{"ID": "parent", "VN": "1"}, {"ID": "child", "PP": "parent"}]
    renames = _merge_programs(programs, [{"ID": "child", "PP": "parent"}, {"ID": "parent", "VN": "2"}])
    assert renames == {"parent": "parent.2", "child": "child.2"}
    by_id = {p["ID"]: p for p in programs}
    assert by_id["child.2"]["PP"] == "parent.2" and by_id["parent.2"]["VN"] == "2"
    assert by_id["child"]["PP"] == "parent" and len(programs) == 4
    # Identical chains are kept once.
    again = [{"ID": "parent", "VN": "1"}, {"ID": "child", "PP": "parent"}]
    assert _merge_programs(again, [{"ID": "child", "PP": "parent"}, {"ID": "parent", "VN": "1"}]) == {}
    assert len(again) == 2
