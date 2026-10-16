"""Datasets on another assembly with a reference of their own (fb-r2-genomes).

Loading a dm6 BAM beside the hg38 demo offered only "load dm6", which
replaced hg38 for every panel. A dataset can now be given its own reference
(services/panel_genomes.py); requests carrying ``panel_genome=<key>`` are
answered from it (sequence, genes, gene search, chromosomes, top windows)
while the main genome stays as it was.
"""
from __future__ import annotations

import random

import pysam
import pytest

from state import runtime_state
from state.browser_state import BrowserState
from services import panel_genomes

MAIN_LEN = 5_000
FLY_LEN = 6_000


def _fasta(path, contigs: dict[str, str]) -> str:
    with open(path, "w") as handle:
        for name, seq in contigs.items():
            handle.write(f">{name}\n")
            for i in range(0, len(seq), 60):
                handle.write(seq[i:i + 60] + "\n")
    pysam.faidx(str(path))
    return str(path)


def _bam(path, contig: str, length: int, *, n: int = 30, at: int = 3_000) -> str:
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": contig, "LN": length}]}
    unsorted = str(path) + ".unsorted.bam"
    rng = random.Random(1)
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for i in range(n):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = f"r{i}"
            seg.reference_id = 0
            seg.reference_start = at + rng.randint(0, 50)
            seg.query_sequence = "ACGT" * 100
            seg.cigarstring = "400M"
            seg.mapping_quality = 60
            seg.query_qualities = pysam.qualitystring_to_array("I" * 400)
            out.write(seg)
    pysam.sort("-o", str(path), unsorted)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def refs(tmp_path):
    rng = random.Random(7)
    main_seq = "".join(rng.choice("ACGT") for _ in range(MAIN_LEN))
    fly_seq = "".join(rng.choice("ACGT") for _ in range(FLY_LEN))
    main_fa = _fasta(tmp_path / "main.fa", {"chr1": main_seq})
    fly_fa = _fasta(tmp_path / "fly.fa", {"chr2L": fly_seq})
    fly_gtf = tmp_path / "fly.gtf"
    fly_gtf.write_text(
        'chr2L\ttest\ttranscript\t1001\t2000\t.\t+\t.\tgene_id "g1"; transcript_id "t1"; gene_name "flyGene";\n'
        'chr2L\ttest\texon\t1001\t2000\t.\t+\t.\tgene_id "g1"; transcript_id "t1"; gene_name "flyGene";\n')
    fly_bam = _bam(tmp_path / "fly.bam", "chr2L", FLY_LEN)
    return {"main_fa": main_fa, "main_seq": main_seq, "fly_fa": fly_fa, "fly_seq": fly_seq,
            "fly_gtf": str(fly_gtf), "fly_bam": fly_bam, "tmp": tmp_path}


@pytest.fixture
def state(refs, standalone_app):
    st = BrowserState(None)
    assert st._load_fasta(refs["main_fa"]) is None
    st.add_dataset("fly", refs["fly_bam"], "fly")
    runtime_state.set_browser_state(st)
    return st


def _attach_fasta(client, refs, **extra):
    return client.post("/api/panel_genomes/attach", json={
        "dataset_ids": ["fly"], "fasta_path": refs["fly_fa"], "gtf_path": refs["fly_gtf"], "span": 1_000, **extra,
    }).json()


def test_attach_gives_the_dataset_its_own_reference(client, state, refs):
    before = client.get("/api/genome/check").json()
    assert [p["dataset_id"] for p in before["problems"]] == ["fly"]  # chr2L isn't in the main reference

    body = _attach_fasta(client, refs)
    assert body["success"] and not body["main"]
    genome = body["genome"]
    assert genome["key"] == "fasta:fly" and genome["has_fasta"] and genome["has_gtf"]
    assert [c["name"] for c in genome["chroms"]] == ["chr2L"]
    # The panel opens where the dataset's reads are, on its own reference.
    locus = body["loci"]["fly"]
    assert locus["chrom"] == "chr2L" and locus["start"] <= 3_050 and locus["end"] >= 3_400

    # The main genome is unchanged.
    assert [c.name for c in state.chroms] == ["chr1"] and state.fasta_path == refs["main_fa"]
    listed = client.get("/api/panel_genomes").json()
    assert listed["datasets"] == {"fly": "fasta:fly"}
    assert listed["genomes"][0]["datasets"] == ["fly"]
    (entry,) = client.get("/api/datasets").json()["datasets"]
    assert entry["genome"] == "fasta:fly"
    # Checked against its own reference: no mismatch any more.
    after = client.get("/api/genome/check").json()
    assert after["problems"] == []
    assert after["datasets"][0]["own_genome"] == "fasta:fly" and after["datasets"][0]["status"] == "match"
    assert client.get("/api/status").json()["genome_mismatch"] is None


def test_requests_with_panel_genome_use_that_reference(client, state, refs):
    _attach_fasta(client, refs)
    seq = client.get("/api/sequence", params={"chrom": "chr2L", "start": 100, "end": 160,
                                              "panel_genome": "fasta:fly"}).json()
    assert seq["sequence"] == refs["fly_seq"][100:160]
    main = client.get("/api/sequence", params={"chrom": "chr1", "start": 100, "end": 160}).json()
    assert main["sequence"] == refs["main_seq"][100:160]
    assert client.get("/api/sequence", params={"chrom": "chr2L", "start": 0, "end": 10}).status_code == 404

    genes = client.get("/api/genes", params={"chrom": "chr2L", "start": 0, "end": 5_000,
                                             "panel_genome": "fasta:fly"}).json()
    assert [g["name"] for g in genes["genes"]] == ["flyGene"]
    assert client.get("/api/genes", params={"chrom": "chr2L", "start": 0, "end": 5_000}).json()["genes"] == []

    found = client.get("/api/gene_search", params={"query": "flyGene", "panel_genome": "fasta:fly"}).json()
    assert found.get("found") and found["chrom"] == "chr2L"

    chroms = client.get("/api/chroms", params={"panel_genome": "fasta:fly"}).json()["chroms"]
    assert [c["name"] for c in chroms] == ["chr2L"]
    assert [c["name"] for c in client.get("/api/chroms").json()["chroms"]] == ["chr1"]

    windows = client.get("/api/reads/top_windows", params={"span": 1_000, "dataset_id": "fly", "n": 1,
                                                           "panel_genome": "fasta:fly"}).json()
    assert windows["windows"][0]["chrom"] == "chr2L"

    # main is the main genome; an unknown key is a 404, not the main genome's answer.
    assert client.get("/api/chroms", params={"panel_genome": "main"}).json()["chroms"][0]["name"] == "chr1"
    assert client.get("/api/chroms", params={"panel_genome": "dm6"}).status_code == 404


def test_one_reference_is_shared_and_closed_with_its_last_dataset(client, state, refs):
    state.add_dataset("fly2", refs["fly_bam"], "fly2")
    body = client.post("/api/panel_genomes/attach", json={
        "dataset_ids": ["fly", "fly2"], "fasta_path": refs["fly_fa"]}).json()
    key = body["genome"]["key"]
    assert state.dataset_genomes == {"fly": key, "fly2": key} and list(state.genome_contexts) == [key]
    again = client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly2"], "fasta_path": refs["fly_fa"]}).json()
    assert again["genome"]["key"] == key and len(state.genome_contexts) == 1  # loaded once

    state.remove_dataset("fly")
    assert list(state.genome_contexts) == [key]
    client.post("/api/panel_genomes/detach", json={"dataset_ids": ["fly2"]})
    assert state.genome_contexts == {} and state.dataset_genomes == {}
    assert client.get("/api/chroms", params={"panel_genome": key}).status_code == 404


def test_registry_genome_and_main_genome(client, state, refs, monkeypatch):
    loaded = []

    def fake_registry(genome_id):
        loaded.append(genome_id)
        ctx = panel_genomes._load_fasta_context(refs["fly_fa"], None)
        ctx._panel_genome_spec = {"kind": "registry", "genome_id": genome_id, "assembly": genome_id,
                                  "label": genome_id, "source": {"genome_id": genome_id}}
        return ctx

    monkeypatch.setattr(panel_genomes, "_load_registry", fake_registry)
    body = client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly"], "genome_id": "dm6"}).json()
    assert body["genome"]["key"] == "dm6" and body["genome"]["label"] == "dm6" and loaded == ["dm6"]
    # The main genome's own id: the dataset follows the main genome.
    state.current_genome = "hg38"
    body = client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly"], "genome_id": "hg38"}).json()
    assert body["main"] is True and state.dataset_genomes == {} and state.genome_contexts == {}
    assert client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly"], "genome_id": "nope"}).status_code == 404


def test_contigs_only_reference(client, state, refs):
    body = client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly"], "contigs": True}).json()
    genome = body["genome"]
    assert genome["key"] == "contigs:fly" and not genome["has_fasta"] and genome["kind"] == "contigs"
    assert genome["chroms"] == [{"name": "chr2L", "size": FLY_LEN, "circular": False}]
    check = client.get("/api/genome/check").json()
    assert check["problems"] == [] and check["datasets"][0]["own_genome"] == "contigs:fly"


def test_header_fasta_is_used_when_on_this_computer(client, state, refs):
    bam = _bam(refs["tmp"] / "ur.bam", "chr2L", FLY_LEN)
    # A header naming its reference (UR) that is here: its sequence comes along.
    with pysam.AlignmentFile(bam) as src:
        header = src.header.to_dict()
        header["SQ"][0]["UR"] = "file:" + refs["fly_fa"]
        out_path = str(refs["tmp"] / "ur2.bam")
        with pysam.AlignmentFile(out_path, "wb", header=header) as out:
            for read in src:
                out.write(read)
    pysam.index(out_path)
    state.add_dataset("ur", out_path, "ur")
    body = client.post("/api/panel_genomes/attach", json={"dataset_ids": ["ur"], "contigs": True}).json()
    assert body["genome"]["kind"] == "header_fasta" and body["genome"]["has_fasta"]


def test_view_writes_reach_the_session_state(state, refs):
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    view = panel_genomes.genome_view(state, "fasta:fly")
    assert isinstance(view, BrowserState) and view.datasets is state.datasets
    assert [c.name for c in view.chroms] == ["chr2L"] and view.translate_chrom("chr2L") == "chr2L"
    view.peak_regions = [("chr2L", 1, 2)]
    assert state.peak_regions == [("chr2L", 1, 2)]
    view.fasta_error = "x"  # a reference attribute: the context's, not the main genome's
    assert state.fasta_error is None and state.genome_contexts["fasta:fly"].fasta_error == "x"
    state.some_later_attribute = 3
    assert view.some_later_attribute == 3
    with pytest.raises(panel_genomes.GenomeUnavailable):
        panel_genomes.genome_view(state, "nope")


def test_forked_session_has_its_own_references(state, refs):
    fork = BrowserState.fork_for_session(state)
    assert fork.genome_contexts == {} and fork.dataset_genomes == {}
    panel_genomes.attach(fork, ["fly"], fasta_path=refs["fly_fa"])
    assert state.genome_contexts == {} and list(fork.genome_contexts) == ["fasta:fly"]
    # A session older than the registries (no attributes yet) reads them as empty.
    del fork.__dict__["genome_contexts"]
    del fork.__dict__["dataset_genomes"]
    assert panel_genomes.dataset_genome(fork, "fly") is None
    from services.genome_check import genome_check
    assert genome_check(fork)["datasets"][0]["dataset_id"] == "fly"


def test_public_server_and_tour_tab_cannot_attach(client, state, refs, monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    assert client.post("/api/panel_genomes/attach", json={"dataset_ids": ["fly"], "contigs": True}).status_code == 403
    monkeypatch.setattr(runtime, "_public_mode", False)
    monkeypatch.setattr(runtime, "current_sandbox_id", lambda: "sbx")
    from fastapi import HTTPException
    from routers.genome import _refuse_panel_genomes
    with pytest.raises(HTTPException) as refused:
        _refuse_panel_genomes()
    assert refused.value.status_code == 403


def test_session_saves_and_restores_each_datasets_reference(state, refs):
    from types import SimpleNamespace
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request

    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"], gtf_path=refs["fly_gtf"])
    req = SimpleNamespace(chrom="chr1", start=0, end=1_000, frontend_state={"panels": []})
    session = build_session_export_for_request(state, req)["session"]
    saved = session["panel_genomes"]
    assert {k: v for k, v in saved.items() if k != "loci"} == {
        "contexts": {"fasta:fly": {"fasta_path": refs["fly_fa"], "gtf_path": refs["fly_gtf"], "circular_chroms": {}}},
        "datasets": {"fly": "fasta:fly"},
    }
    # Where its panel starts in a window opened later (fb-n2-files L12).
    assert saved["loci"]["fly"]["chrom"] == "chr2L"
    panel_genomes.clear(state)
    restored = import_session_for_request(state, SimpleNamespace(session=session, path_mapping=None))
    assert restored["results"]["panel_genomes_restored"] == 1
    assert state.dataset_genomes == {"fly": "fasta:fly"}
    assert panel_genomes.payload(state)["loci"] == saved["loci"]
    assert state.genome_contexts["fasta:fly"].gtf_data is not None

    # A session saved before this feature (no panel_genomes): nothing attached.
    old = {k: v for k, v in session.items() if k != "panel_genomes"}
    restored = import_session_for_request(state, SimpleNamespace(session=old, path_mapping=None))
    assert "panel_genomes_restored" not in restored["results"]
    assert state.dataset_genomes == {} and state.genome_contexts == {}


def test_primer_settings_of_the_main_genome_never_reach_another_assembly(state, refs):
    state.primer_fasta = refs["main_fa"]
    state.primer_blast_db = "/blast/main"
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    view = panel_genomes.genome_view(state, "fasta:fly")
    assert view.primer_fasta is None and view.primer_blast_db is None
    from services.primer_reference import get_fasta_interface
    fetch, _length, names = get_fasta_interface(view, view.primer_fasta or view.fasta_path)
    assert names == {"chr2L"} and fetch("chr2L", 0, 10) == refs["fly_seq"][:10]


def test_analyses_of_a_dataset_read_its_own_reference(state, refs):
    state.add_dataset("main_ds", refs["fly_bam"], "main_ds")
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    assert panel_genomes.for_datasets(state, ["fly"]).fasta_path == refs["fly_fa"]
    # Mixed or main-genome datasets: the main reference.
    assert panel_genomes.for_datasets(state, ["fly", "main_ds"]) is state
    assert panel_genomes.for_datasets(state, ["main_ds"]) is state
    assert panel_genomes.for_datasets(state, []) is state


def test_footprint_sequences_come_from_the_datasets_reference(state, refs):
    from models.requests import FootprintAnalysisRequest
    from services.footprint_endpoint import analyze_footprints_payload
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    req = FootprintAnalysisRequest(
        footprints=[{"absStart": 3_100, "absEnd": 3_120, "size": 20}], flank_bp=5, dataset_ids=["fly"],
        include_sequences=True, include_read_analysis=False, include_motifs=False)
    out = analyze_footprints_payload(state, chrom="chr2L", region_start=3_000, region_end=3_500, spanning=False, request=req)
    seq = out["footprints"][0]["sequence"]
    assert seq == refs["fly_seq"][3_095:3_125]


def test_switching_the_main_genome_to_a_datasets_own_one_drops_the_copy(state, refs, monkeypatch):
    def fake_registry(genome_id):
        ctx = panel_genomes._load_fasta_context(refs["fly_fa"], None)
        ctx._panel_genome_spec = {"kind": "registry", "genome_id": genome_id, "source": {"genome_id": genome_id}}
        return ctx
    monkeypatch.setattr(panel_genomes, "_load_registry", fake_registry)
    panel_genomes.attach(state, ["fly"], genome_id="dm6")
    state.current_genome = "dm6"  # as POST /api/load_genome?genome_id=dm6 leaves it
    assert panel_genomes.release_main_genome(state) == ["fly"]
    assert state.genome_contexts == {} and state.dataset_genomes == {}


def test_read_requests_for_a_dataset_use_its_reference(client, state, refs, monkeypatch):
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    import services.random_window as random_window
    seen = []
    real = random_window.random_covered_window

    def spy(st, **kw):
        seen.append([c.name for c in st.chroms])
        return real(st, **kw)
    monkeypatch.setattr(random_window, "random_covered_window", spy)
    client.get("/api/reads/random_window", params={"span": 500, "dataset_id": "fly"})
    client.get("/api/reads/random_window", params={"span": 500})
    assert seen == [["chr2L"], ["chr1"]]


def test_session_restore_keeps_the_saved_keys(state, refs):
    from types import SimpleNamespace
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    other = refs["tmp"] / "other"
    other.mkdir()
    other_fa = _fasta(other / "fly.fa", {"chr2L": "ACGT" * 1500})
    state.add_dataset("fly2", refs["fly_bam"], "fly2")
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    panel_genomes.attach(state, ["fly2"], fasta_path=other_fa)
    assert state.dataset_genomes == {"fly": "fasta:fly", "fly2": "fasta:fly-2"}
    session = build_session_export_for_request(state, SimpleNamespace(chrom="chr1", start=0, end=10, frontend_state={}))["session"]
    from services.session_files import session_file_refs
    paths = {r["path"] for r in session_file_refs(session)}
    assert refs["fly_fa"] in paths and other_fa in paths
    # Restored in the other order: each dataset keeps its key (its panels name it).
    session["panel_genomes"]["datasets"] = {"fly2": "fasta:fly-2", "fly": "fasta:fly"}
    panel_genomes.clear(state)
    import_session_for_request(state, SimpleNamespace(session=session, path_mapping=None))
    assert state.dataset_genomes == {"fly2": "fasta:fly-2", "fly": "fasta:fly"}
    assert state.genome_contexts["fasta:fly-2"].fasta_path == other_fa


def test_footprints_across_assemblies_get_no_sequences(state, refs):
    from models.requests import FootprintAnalysisRequest
    from services.footprint_endpoint import analyze_footprints_payload
    state.add_dataset("main_ds", refs["fly_bam"], "main_ds")
    panel_genomes.attach(state, ["fly"], fasta_path=refs["fly_fa"])
    req = FootprintAnalysisRequest(
        footprints=[{"absStart": 3_100, "absEnd": 3_120, "size": 20}], flank_bp=5, dataset_ids=["fly", "main_ds"],
        include_sequences=True, include_read_analysis=False, include_motifs=False)
    out = analyze_footprints_payload(state, chrom="chr2L", region_start=3_000, region_end=3_500, spanning=False, request=req)
    assert out["footprints"][0].get("sequence") in (None, "")
    assert any("different assemblies" in w for w in out["warnings"])


def test_concurrent_attaches_of_same_named_fastas_keep_their_own(state, refs):
    import threading
    other = refs["tmp"] / "other2"
    other.mkdir()
    other_fa = _fasta(other / "fly.fa", {"chr2L": "ACGT" * 1500})
    state.add_dataset("fly2", refs["fly_bam"], "fly2")
    errors = []

    def go(ds, fa):
        try:
            panel_genomes.attach(state, [ds], fasta_path=fa, span=0)
        except Exception as exc:  # pragma: no cover
            errors.append(exc)
    threads = [threading.Thread(target=go, args=("fly", refs["fly_fa"])), threading.Thread(target=go, args=("fly2", other_fa))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    paths = {d: state.genome_contexts[k].fasta_path for d, k in state.dataset_genomes.items()}
    assert paths == {"fly": refs["fly_fa"], "fly2": other_fa}


def test_header_fasta_of_a_remote_bam_paired_with_its_index(refs, monkeypatch):
    """A remote BAM opened with its index (``data##idx##index``) is still a BAM:
    its header's UR FASTA is found (the suffix is the data part's, not the index's)."""
    import services.remote_sources.opening as opening
    from types import SimpleNamespace

    bam = _bam(refs["tmp"] / "ur.bam", "chr2L", FLY_LEN)
    with pysam.AlignmentFile(bam) as src:
        header = src.header.to_dict()
    header["SQ"][0]["UR"] = "file:" + refs["fly_fa"]
    local = str(refs["tmp"] / "ur_header.bam")
    with pysam.AlignmentFile(local, "wb", header=header):
        pass
    paired = "https://example.org/fly.bam##idx##https://example.org/fly.bam.bai"
    opened = []

    def fake_open(path, mode="rb", **kwargs):
        opened.append(path)
        return pysam.AlignmentFile(local, mode, **kwargs)

    monkeypatch.setattr(opening, "open_alignment_file", fake_open)
    dataset = SimpleNamespace(paths=[paired], path=paired)
    assert panel_genomes._header_fasta(dataset) == refs["fly_fa"]
    assert opened == [paired]


def test_footprint_class_run_refuses_datasets_on_two_references(client, state, refs):
    """One run covers one region of one reference: a dataset on its own reference
    is not run together with one on the main genome (fb-r2-integ)."""
    from services import consensus_workflow

    state.add_dataset("main", _bam(refs["tmp"] / "main.bam", "chr1", MAIN_LEN), "main")
    assert _attach_fasta(client, refs)["success"]
    with pytest.raises(ValueError, match="different references"):
        consensus_workflow.submit(state, {"dataset_ids": ["main", "fly"], "chrom": "chr1", "start": 0, "end": 1_000,
                                          "chemistry_overrides": {"main": "ddda", "fly": "ddda"}, "parameters": {}})


@pytest.mark.parametrize("contigs_only", [False, True])
def test_reference_manager_edits_are_scoped_and_survive_session(client, state, refs, contigs_only):
    attached = panel_genomes.attach(state, ["fly"], contigs=True) if contigs_only else _attach_fasta(client, refs)
    key = attached["genome"]["key"]
    annotation = refs['tmp'] / 'edited.gtf'
    annotation.write_text((refs['tmp'] / 'fly.gtf').read_text().replace('flyGene', 'editedGene'))
    assert client.post('/api/load_gtf', params={'path': str(annotation), 'panel_genome': key}).json()['success']
    assert client.post('/api/circular_chrom', params={'chrom': 'chr2L', 'circular': True, 'panel_genome': key}).json()['success']
    assert state.gtf_path != str(annotation)
    assert not state.circular_chroms
    saved = panel_genomes.session_export(state)
    assert saved['contexts'][key]['gtf_path'] == str(annotation)
    assert 'chr2L' in saved['contexts'][key]['circular_chroms']
    # Picking the same loaded FASTA after editing its annotation reuses it.
    if not contigs_only:
        same = panel_genomes.attach(state, ['fly'], fasta_path=refs['fly_fa'], gtf_path=str(annotation))
        assert same['genome']['key'] == key
    restored = panel_genomes.session_restore(state, saved)
    assert restored['failed'] == []
    ctx = panel_genomes.contexts(state)[key]
    assert ctx.gtf_path == str(annotation)
    assert any(c.name == 'chr2L' and c.circular for c in ctx.chroms)
    assert client.post('/api/circular_chrom', params={'chrom': 'chr2L', 'circular': False, 'panel_genome': key}).json()['success']
    saved = panel_genomes.session_export(state)
    assert panel_genomes.session_restore(state, saved)['failed'] == []
    assert not panel_genomes.contexts(state)[key].circular_chroms


@pytest.mark.parametrize("custom_annotation", [False, True])
def test_registry_session_restores_with_another_machines_cache(client, state, refs, monkeypatch, custom_annotation):
    from services import genome_loading, gene_annotations

    cache_paths = iter(['/old-machine/cache/dm6.gtf', '/new-machine/cache/dm6.gtf'])

    def load_registry(ctx, genome_id, info):
        assert ctx._load_fasta(refs['fly_fa']) is None
        ctx.gtf_data = gene_annotations.load_gtf(refs['fly_gtf'])
        ctx.gtf_path = next(cache_paths)
        return {'success': True}

    monkeypatch.setattr(genome_loading, 'load_genome_blocking', load_registry)
    panel_genomes.attach(state, ['fly'], genome_id='dm6', span=0)
    if custom_annotation:
        assert client.post('/api/load_gtf', params={'path': refs['fly_gtf'], 'panel_genome': 'dm6'}).json()['success']
    assert client.post('/api/circular_chrom', params={'chrom': 'chr2L', 'circular': True, 'panel_genome': 'dm6'}).json()['success']
    locus = {'chrom': 'chr2L', 'start': 100, 'end': 900}
    panel_genomes.start_loci(state)['fly'] = {'key': 'dm6', 'locus': locus}
    saved = panel_genomes.session_export(state)
    source = saved['contexts']['dm6']
    if custom_annotation:
        assert source['gtf_path'] == refs['fly_gtf']
    else:
        assert 'gtf_path' not in source
    assert panel_genomes.session_restore(state, saved) == {'restored': 1, 'failed': []}
    ctx = panel_genomes.contexts(state)['dm6']
    assert ctx.gtf_path == (refs['fly_gtf'] if custom_annotation else '/new-machine/cache/dm6.gtf')
    assert any(c.name == 'chr2L' and c.circular for c in ctx.chroms)
    assert panel_genomes.start_loci(state)['fly']['locus'] == locus
    assert panel_genomes.session_export(state) == saved
