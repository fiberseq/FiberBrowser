"""Assembly fingerprinting and genome/dataset mismatch detection (fb-genomecheck).

A BAM aligned to one assembly under another loaded genome showed no reads (or
reads under the wrong sequence and genes) without saying why. These cover
services/assembly_fingerprint.py, services/genome_check.py and the routes.
"""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pysam
import pytest

from services.assembly_fingerprint import ASSEMBLIES, fingerprint, header_contigs
from services.genome_check import blocking_mismatch, check_dataset, genome_check

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"

HG38 = ASSEMBLIES["hg38"]["contigs"]
HG19 = ASSEMBLIES["hg19"]["contigs"]
DM6 = ASSEMBLIES["dm6"]["contigs"]


def _ensembl(contigs: dict) -> dict:
    return {name[3:] if name.startswith("chr") else name: length for name, length in contigs.items()}


# ---------------------------------------------------------------------------
# Fingerprinting
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("assembly", ["hg38", "hg19", "mm10", "mm39", "dm6", "sacCer3", "chm13"])
@pytest.mark.parametrize("style", ["ucsc", "ensembl"])
def test_fingerprint_names_the_assembly_from_lengths(assembly, style):
    contigs = ASSEMBLIES[assembly]["contigs"]
    if style == "ensembl":
        contigs = _ensembl(contigs)
    fp = fingerprint(list(contigs.items()) + [("chrM" if style == "ucsc" else "MT", 16_569)])
    assert fp.assembly == assembly and fp.confidence == "high" and fp.kind == "genome"
    assert fp.naming == style
    assert fp.in_registry is (assembly != "chm13")


def test_fingerprint_refseq_names_are_the_same_assembly_other_names():
    fp = fingerprint([("NC_000001.11", HG38["chr1"]), ("NC_000002.12", HG38["chr2"])])
    assert fp.assembly == "hg38" and fp.confidence == "high" and fp.naming == "ncbi"


def test_one_distinctive_contig_is_medium_confidence():
    # A BigBed lists only chromosomes with data.
    fp = fingerprint([("chr2L", DM6["chr2L"])])
    assert fp.assembly == "dm6" and fp.confidence == "medium"


def test_as_tag_names_the_assembly_when_lengths_dont():
    contigs, labels = header_contigs({"SQ": [{"SN": "chr1", "LN": 1000, "AS": "GRCh38"},
                                             {"SN": "scaffold_2", "LN": 900_000, "AS": "GRCh38"}]})
    fp = fingerprint(contigs, labels=labels)
    assert fp.assembly == "hg38" and fp.confidence == "medium" and fp.declared == "hg38"


def test_conflicting_as_tag_loses_to_lengths_and_is_reported():
    sq = [{"SN": n, "LN": l, "AS": "GRCh37"} for n, l in HG38.items()]
    contigs, labels = header_contigs({"SQ": sq})
    fp = fingerprint(contigs, labels=labels)
    assert fp.assembly == "hg38" and fp.declared == "hg19"
    assert fp.conflicts and "GRCh37" in fp.conflicts[0]


def test_ur_path_names_the_assembly():
    contigs, labels = header_contigs({"SQ": [{"SN": "ctg1", "LN": 4_000_000, "UR": "file:/refs/T2T-CHM13v2.fa"}]})
    assert fingerprint(contigs, labels=labels).assembly == "chm13"


def test_plasmid_only_header_is_unknown_assembly():
    fp = fingerprint([("pUC19", 2686), ("pFiber_amp", 7_450)])
    assert fp.assembly is None and fp.kind == "plasmid" and fp.confidence == "none"


def test_unplaced_and_mito_contigs_never_fingerprint():
    # hg38 chrM (16,569 bp) is GRCh37's MT too; unplaced contigs vary by release.
    fp = fingerprint([("chrM", 16_569), ("chr1_KI270706v1_random", 175_055)])
    assert fp.assembly is None


def test_hybrid_reference_names_the_larger_share():
    fp = fingerprint(list(HG38.items()) + [("mm_chr1", ASSEMBLIES["mm10"]["contigs"]["chr1"])])
    assert fp.assembly == "hg38" and fp.others == ["mm10"]


def test_library_guess_genome_uses_the_fingerprint():
    from services.library_inspect import _guess_genome
    assert _guess_genome(dict(_ensembl(DM6))) == "dm6"
    assert _guess_genome({"chr1": ASSEMBLIES["chm13"]["contigs"]["chr1"],
                          "chr2": ASSEMBLIES["chm13"]["contigs"]["chr2"]}) is None  # not a registry genome
    assert _guess_genome({"pUC19": 2686}) is None


# ---------------------------------------------------------------------------
# Mismatch detection
# ---------------------------------------------------------------------------

class FakeFasta:
    def __init__(self, contigs: dict):
        self.references = tuple(contigs)
        self.lengths = tuple(contigs.values())

    def get_reference_length(self, name):
        return dict(zip(self.references, self.lengths))[name]


def _bam(tmp_path, name: str, contigs: dict, **tags) -> str:
    path = str(tmp_path / name)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"},
              "SQ": [{"SN": n, "LN": int(l), **tags} for n, l in contigs.items()]}
    with pysam.AlignmentFile(path, "wb", header=header):
        pass
    return path


def _dataset(dataset_id: str, path: str, label: str | None = None):
    return SimpleNamespace(id=dataset_id, label=label or os.path.basename(path), path=path, paths=[path],
                           data_type="bam")


def _state(datasets, *, fasta=None, fasta_path=None, current_genome=None, plasmids=None, plasmid_metadata=None):
    datasets = list(datasets)
    return SimpleNamespace(
        datasets={d.id: d for d in datasets}, dataset_order=[d.id for d in datasets],
        fasta=FakeFasta(fasta) if fasta is not None else None, fasta_path=fasta_path,
        current_genome=current_genome, plasmid_sequences=dict(plasmids or {}),
        plasmid_metadata=dict(plasmid_metadata or {}), gtf_data=None,
    )


with pysam.AlignmentFile(str(DEMO_BAM), "rb", check_sq=False) as _bam_handle:
    # hg38's own contig list (the demo BAM was aligned to it), minus some unplaced contigs.
    HG38_FASTA = {n: l for n, l in zip(_bam_handle.references, _bam_handle.lengths)
                  if "_" not in n or n == "chr1_KI270706v1_random"}
DM6_FASTA = {**DM6, "chrY": 3_667_352, "chrM": 19_524}


def test_demo_bam_is_hg38():
    ds = _dataset("demo", str(DEMO_BAM))
    check = check_dataset(_state([ds]), "demo")
    assert check["assembly"]["assembly"] == "hg38" and check["assembly"]["confidence"] == "high"


def test_right_genome_matches():
    ds = _dataset("demo", str(DEMO_BAM))
    check = check_dataset(_state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa", current_genome="hg38"), "demo")
    assert check["status"] == "match" and check["severity"] == "ok" and check["message"] is None
    assert check["suggestion"] is None


def test_wrong_genome_names_both_assemblies_and_suggests_the_right_one():
    ds = _dataset("demo", str(DEMO_BAM))
    state = _state([ds], fasta=DM6_FASTA, fasta_path="/refs/dm6.fa", current_genome="dm6")
    check = check_dataset(state, "demo")
    assert check["status"] == "different_assembly" and check["severity"] == "error"
    assert check["message"] == ("napa_ddda.bam was aligned to hg38, but dm6 is loaded — "
                                "reads won't line up with the reference.")
    assert check["suggestion"]["genome_id"] == "hg38"
    assert blocking_mismatch(state) == {"dataset_ids": ["demo"], "message": check["message"]}


def test_hg19_bam_under_hg38_is_a_length_mismatch(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "old.bam", {**HG19, "chrM": 16_571}))
    check = check_dataset(_state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa"), "a")
    assert check["status"] == "different_assembly"
    assert "aligned to hg19, but hg38 is loaded" in check["message"]
    assert check["suggestion"]["genome_id"] == "hg19"
    assert {d["contig"] for d in check["details"]["length_differs"]} >= {"chr1", "chr2"}


def test_custom_fasta_lengths_differ_without_a_known_assembly(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "custom.bam", {"ctg1": 3_000_000, "ctg2": 2_000_000}))
    state = _state([ds], fasta={"ctg1": 3_000_100, "ctg2": 2_000_000}, fasta_path="/refs/my_assembly.fa")
    check = check_dataset(state, "a")
    assert check["status"] == "different_assembly" and check["suggestion"] is None
    assert "ctg1 is 3,000,000 bp in the file but 3,000,100 bp in the reference" in check["message"]
    assert "my_assembly.fa" in check["message"]


def test_chr_prefix_difference_is_matched_by_the_app(tmp_path):
    # chr1 vs 1 (and chrM vs MT): the app aliases these names everywhere.
    ds = _dataset("a", _bam(tmp_path, "ens.bam", {**_ensembl(HG38), "MT": 16_569}))
    check = check_dataset(_state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa"), "a")
    assert check["status"] == "match"
    assert check["assembly"]["naming"] == "ensembl"


def test_refseq_names_are_same_assembly_other_names(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "refseq.bam", {"NC_000001.11": HG38["chr1"], "NC_000002.12": HG38["chr2"],
                                                     "NC_000003.12": HG38["chr3"]}))
    check = check_dataset(_state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa", current_genome="hg38"), "a")
    assert check["status"] == "other_names" and check["severity"] == "error"
    assert "same assembly (hg38)" in check["message"] and "NC_000001.11" in check["message"]
    assert check["suggestion"] is None  # loading hg38 again would not help


def test_extra_plasmid_contig_is_reported_until_its_map_is_linked(tmp_path):
    path = _bam(tmp_path, "with_plasmid.bam", {**HG38, "pFiber": 7_450})
    ds = _dataset("a", path)
    state = _state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa", current_genome="hg38")
    check = check_dataset(state, "a")
    assert check["status"] == "missing_contigs" and check["severity"] == "warning"
    assert "pFiber is in with_plasmid.bam but not in hg38" in check["message"]
    # Linked to a loaded plasmid map (another name): not counted any more.
    state.plasmid_sequences = {"pFiber_map": "A" * 7_450}
    state.plasmid_metadata = {"pFiber_map": {"source": "plasmid_map", "size": 7_450,
                                             "links": [{"dataset_id": "a", "contig": "pFiber", "paths": [path]}]}}
    linked = check_dataset(state, "a")
    assert linked["status"] == "match"
    assert linked["details"]["ignored"][0]["contig"] == "pFiber"


def test_plasmid_map_of_the_same_name_fits(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "amplicon.bam", {"pUC19": 2686}))
    state = _state([ds], plasmids={"pUC19": "ACGT" * 671 + "AC"})
    assert check_dataset(state, "a")["status"] == "match"


def test_plasmid_only_bam_under_a_genome_offers_no_genome(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "amplicon.bam", {"pUC19": 2686}))
    check = check_dataset(_state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa", current_genome="hg38"), "a")
    assert check["status"] == "missing_contigs" and check["severity"] == "error"
    assert check["assembly"]["kind"] == "plasmid" and check["suggestion"] is None
    assert "None of amplicon.bam's contigs (pUC19) are in hg38" in check["message"]


def test_unplaced_contigs_and_a_mito_difference_dont_count(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "fly.bam", {**DM6, "chrM": 19_517, "chrUn_DS485919v1": 1021}))
    check = check_dataset(_state([ds], fasta=DM6_FASTA, fasta_path="/refs/dm6.fa"), "a")
    assert check["status"] == "match"
    assert "chrM is 19,517 bp" in check["details"]["notes"][0]


def test_m5_checksum_difference(tmp_path):
    ds = _dataset("a", _bam(tmp_path, "m5.bam", {"chr2L": DM6["chr2L"], "chr2R": DM6["chr2R"]}, M5="0" * 32))
    fasta = tmp_path / "dm6.fa"
    (tmp_path / "dm6.dict").write_text(f"@HD\tVN:1.6\n@SQ\tSN:chr2L\tLN:{DM6['chr2L']}\tM5:{'a' * 32}\n")
    check = check_dataset(_state([ds], fasta=DM6_FASTA, fasta_path=str(fasta)), "a")
    assert check["status"] == "sequence_differs" and "chr2L" in check["message"]


def test_registry_genome_without_fasta_still_detects_the_mismatch():
    ds = _dataset("demo", str(DEMO_BAM))
    check = check_dataset(_state([ds], current_genome="dm6"), "demo")
    assert check["status"] == "different_assembly" and check["reference"]["kind"] == "registry"


def test_registry_genome_without_fasta_and_no_shared_chromosome(tmp_path):
    # A fly BAM under hg38's annotation only: no fingerprinted hg38 chromosome is in it.
    ds = _dataset("fly", _bam(tmp_path, "fly.bam", DM6))
    check = check_dataset(_state([ds], current_genome="hg38"), "fly")
    assert check["status"] == "different_assembly" and "aligned to dm6, but hg38 is loaded" in check["message"]


def test_no_reference_suggests_the_bam_genome():
    ds = _dataset("demo", str(DEMO_BAM))
    result = genome_check(_state([ds]))
    assert result["reference"]["kind"] == "none"
    assert result["datasets"][0]["status"] == "no_reference" and result["problems"] == []
    assert result["suggestion"]["genome_id"] == "hg38" and result["suggestion"]["datasets"] == ["napa_ddda.bam"]


def test_datasets_of_different_assemblies_get_no_single_suggestion(tmp_path):
    fly = _dataset("fly", _bam(tmp_path, "fly.bam", DM6))
    human = _dataset("demo", str(DEMO_BAM))
    assert genome_check(_state([human, fly]))["suggestion"] is None


def test_fragmented_assembly_is_quick_and_listed_briefly(tmp_path):
    # 5,000 scaffolds on both sides (a de novo assembly), 3,000 of them renamed in the file.
    import time
    scaffolds = {f"scaffold_{i}": 10_000 + i for i in range(5_000)}
    in_file = {(f"ctg{i}" if i < 3_000 else name): length for i, (name, length) in enumerate(scaffolds.items())}
    ds = _dataset("a", _bam(tmp_path, "denovo.bam", in_file))
    state = _state([ds], fasta=scaffolds, fasta_path="/refs/denovo.fa")
    t0 = time.perf_counter()
    first = genome_check(state)["datasets"][0]
    assert time.perf_counter() - t0 < 1.0
    assert first["status"] == "missing_contigs" and first["severity"] == "warning"  # 2,000 still fit
    assert first["details"]["n_renamed"] == 3_000 and len(first["details"]["renamed"]) == 50
    # Asked again (every /api/status): cached until something changes.
    t0 = time.perf_counter()
    assert genome_check(state)["datasets"][0] is first
    assert time.perf_counter() - t0 < 0.05
    state.fasta = FakeFasta(in_file)
    assert genome_check(state)["datasets"][0]["status"] == "match"


def test_unreadable_dataset_is_unknown_not_an_error(tmp_path):
    ds = _dataset("a", str(tmp_path / "missing.bam"))
    check = check_dataset(_state([ds], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa"), "a")
    assert check["status"] == "unknown" and check["severity"] == "info"


def test_remote_bam_with_explicit_index_is_still_checked(monkeypatch):
    """A remote BAM opened with its index (``data##idx##index``, the file opener's
    pairing) is classified by its data part: the check names its assembly instead
    of returning "unknown", and the whole string is what gets opened."""
    import services.remote_sources.opening as opening

    paired = "https://example.org/runs/sample.bam##idx##https://example.org/runs/sample.bam.bai"
    opened = []

    def fake_open(path, mode="rb", **kwargs):
        opened.append(path)
        return pysam.AlignmentFile(str(DEMO_BAM), mode, **kwargs)

    monkeypatch.setattr(opening, "open_alignment_file", fake_open)
    ds = _dataset("remote", paired, label="sample")
    check = check_dataset(_state([ds], fasta=DM6_FASTA, fasta_path="/refs/dm6.fa", current_genome="dm6"), "remote")
    assert opened == [paired]
    assert check["status"] == "different_assembly"
    assert check["assembly"]["assembly"] == "hg38"


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@pytest.fixture
def wrong_genome(monkeypatch):
    import server as srv
    ds = _dataset("demo", str(DEMO_BAM))
    ds.to_dict = lambda: {"id": "demo", "label": "napa_ddda.bam", "path": str(DEMO_BAM)}
    monkeypatch.setattr(srv.state, "datasets", {"demo": ds})
    monkeypatch.setattr(srv.state, "dataset_order", ["demo"])
    monkeypatch.setattr(srv.state, "fasta", FakeFasta(DM6_FASTA))
    monkeypatch.setattr(srv.state, "fasta_path", "/refs/dm6.fa")
    monkeypatch.setattr(srv.state, "current_genome", "dm6")
    return srv.state


def test_genome_check_route(client, wrong_genome):
    body = client.get("/api/genome/check").json()
    assert body["reference"]["label"] == "dm6" and body["can_load_genomes"] is True
    (problem,) = body["problems"]
    assert problem["dataset_id"] == "demo" and problem["status"] == "different_assembly"
    assert problem["suggestion"]["genome_id"] == "hg38" and problem["suggestion"]["can_load"] is True


def test_dataset_assembly_route(client, wrong_genome):
    body = client.get("/api/datasets/demo/assembly").json()
    assert body["assembly"]["assembly"] == "hg38" and body["status"] == "different_assembly"
    assert client.get("/api/datasets/nope/assembly").status_code == 404


def test_dataset_list_carries_the_check(client, wrong_genome):
    (entry,) = client.get("/api/datasets").json()["datasets"]
    assert entry["genome_check"]["assembly"] == "hg38"
    assert entry["genome_check"]["severity"] == "error" and entry["genome_check"]["suggested_genome"] == "hg38"


def test_status_does_not_jump_to_reads_on_the_wrong_reference(client, wrong_genome, monkeypatch):
    # The best-covered locus of a BAM on another assembly: no automatic jump there.
    monkeypatch.setattr(type(wrong_genome), "get_initial_position",
                        lambda self, *a, **k: {"chrom": "chr1", "start": 0, "end": 10_000, "gene_name": ""})
    body = client.get("/api/status").json()
    assert body["initial_position"] is None
    assert body["genome_mismatch"]["dataset_ids"] == ["demo"]
    # The right reference: the jump comes back.
    monkeypatch.setattr(wrong_genome, "fasta", FakeFasta(HG38_FASTA))
    monkeypatch.setattr(wrong_genome, "fasta_path", "/refs/hg38.fa")
    monkeypatch.setattr(wrong_genome, "current_genome", "hg38")
    body = client.get("/api/status").json()
    assert body["genome_mismatch"] is None and body["initial_position"]["chrom"] == "chr1"


def test_public_server_reports_but_never_offers_a_download(client, wrong_genome, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    resp = client.get("/api/genome/check")
    assert resp.status_code == 200
    body = resp.json()
    assert body["can_load_genomes"] is False
    assert body["problems"][0]["suggestion"]["can_load"] is False
    assert "/refs/" not in resp.text  # no host paths
    assert client.get("/api/datasets/demo/assembly").status_code == 200


def test_copilot_diagnostics_name_the_mismatch(wrong_genome):
    from services.natural_language_commands import _server_diagnostics
    found = _server_diagnostics(wrong_genome, None, True, [])
    assert any(d["code"] == "genome_mismatch" and d["dataset_id"] == "demo" for d in found)


# ---------------------------------------------------------------------------
# Real data (the lab's dm6 files; skipped without FIBERBROWSER_TEST_DATA_DIR)
# ---------------------------------------------------------------------------

@pytest.mark.integration
def test_real_dm6_bam_and_bigbed():
    from conftest import DROSOPHILA_DIR, data_file_available
    daf = DROSOPHILA_DIR / "Datasets" / "DAF-seq" / "daf_timecourse" / "geo_subset"
    bams = sorted(daf.glob("*.bam")) if daf.is_dir() else []
    bbs = sorted((DROSOPHILA_DIR / "Datasets" / "Fiber-seq" / "S2").glob("*.fp.bb"))
    files = [p for p in bams[:1] + bbs[:1] if data_file_available(p)]
    if not files:
        pytest.skip("no dm6 BAM/BigBed in FIBERBROWSER_TEST_DATA_DIR")
    datasets = [_dataset(f"d{i}", str(p)) for i, p in enumerate(files)]
    for ds in datasets:
        ds.data_type = "bigbed" if ds.path.endswith(".bb") else "bam"
    right = genome_check(_state(datasets, fasta=DM6_FASTA, fasta_path="/refs/dm6.fa"))
    assert all(c["assembly"]["assembly"] == "dm6" and c["status"] == "match" for c in right["datasets"])
    wrong = genome_check(_state(datasets, fasta=HG38_FASTA, fasta_path="/refs/hg38.fa"))
    assert all(c["status"] == "different_assembly" and c["suggestion"]["genome_id"] == "dm6"
               for c in wrong["datasets"])
