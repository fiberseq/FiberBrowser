"""Map suggestions stay inside their folder and a lab server's data roots (B3)."""
import os
from types import SimpleNamespace

pytest_plugins = ["conftest"]
from lab_fixtures import _lab, lab, member_client  # noqa: F401
from live_lift_fixtures import MAT, SSIZE, make_record, write_bam, write_toy_sidecar


def test_empty_near_scans_no_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    outer = tmp_path / "outer"
    (outer / "workdir").mkdir(parents=True)
    (outer / "sibling").mkdir()
    write_toy_sidecar(str(outer))
    write_toy_sidecar(str(outer / "sibling"))
    monkeypatch.chdir(outer / "workdir")
    from services.lift.suggest import suggest_maps
    assert suggest_maps(SimpleNamespace(datasets={}), "")["maps"] == []
    assert suggest_maps(SimpleNamespace(datasets={}), "https://example.org/a.bam")["maps"] == []


def test_lab_member_suggestions_stay_inside_data_roots(lab, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    parent_leak = write_toy_sidecar(str(lab.data.parent))
    outside_leak = write_toy_sidecar(str(lab.outside))
    write_bam(str(lab.outside / "outside_src.bam"), lambda h: [make_record(h, "r", MAT, 10, "50M")], contigs=[(MAT, SSIZE)])
    inside_bam = lab.data / "inside_src.bam"
    write_bam(str(inside_bam), lambda h: [make_record(h, "r", MAT, 10, "50M")], contigs=[(MAT, SSIZE)])
    inside_map = write_toy_sidecar(str(lab.data / "maps"))
    alice = member_client(lab)
    r = alice.get("/api/lift/maps", params={"near": str(inside_bam)})
    assert r.status_code == 200, r.text
    found = {m["manifest"] for m in r.json()["maps"]}
    assert os.path.abspath(parent_leak) not in found          # never above the data root
    assert os.path.realpath(inside_map) in {os.path.realpath(p) for p in found}   # its own subfolder is fine
    monkeypatch.chdir(lab.data)
    r = alice.get("/api/lift/maps", params={"near": "../outside/outside_src.bam"})
    assert r.status_code in (400, 403), r.text                 # near is a path: scanned and confined
    r = alice.get("/api/lift/maps", params={"near": str(lab.outside / "outside_src.bam")})
    assert r.status_code in (400, 403), r.text
    assert os.path.abspath(outside_leak) not in r.text


def test_lab_member_source_fasta_is_confined(lab, monkeypatch):
    """agy probe: the source assembly FASTA (and its index) stays inside the lab's data roots."""
    import pysam
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    sidecar = write_toy_sidecar(str(lab.data / "maps"))
    bam = write_bam(str(lab.data / "src.bam"), lambda h: [make_record(h, "r", MAT, 100, "200M")], contigs=[(MAT, SSIZE)])
    outside = lab.outside / "secret.fa"
    outside.write_text(f">{MAT}\n{'G' * SSIZE}\n")
    pysam.faidx(str(outside))
    linked = lab.data / "linked.fa"
    linked.write_text(f">{MAT}\n{'G' * SSIZE}\n")
    (lab.data / "linked.fa.fai").symlink_to(lab.outside / "secret.fa.fai")
    alice = member_client(lab)
    for source in (str(outside), str(linked)):
        r = alice.post("/api/lift/datasets", json={"paths": [bam], "manifest": sidecar, "source_fasta": source})
        assert r.status_code == 403 or not r.json().get("success"), (source, r.text)
