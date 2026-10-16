"""An expanded insert (alt allele) is the same genome as its source; a custom FASTA can be declared one.

The alt allele's contig keeps its own coordinates (insert space) but takes the source reference's genome
identity: JASPAR species and taxon, the TE library. Genes of the genome are not mapped onto it (none).
A FASTA nothing identifies is scanned with the vertebrate JASPAR matrices, with a note, until the user
declares its genome (kept per FASTA path, and in sessions).
"""
from __future__ import annotations

import json
import os
import shutil

import pytest

from insertion_fixtures import SITE, make_insertion_bam
from services import motifs

needs_jaspar = pytest.mark.skipif(not motifs.check_pyjaspar(), reason="pyjaspar not installed")


@pytest.fixture(scope="module")
def fixture(tmp_path_factory):
    return make_insertion_bam(tmp_path_factory.mktemp("insertion"))


@pytest.fixture()
def alt_dir(tmp_path, monkeypatch):
    path = tmp_path / "alt"
    monkeypatch.setenv("FIBERBROWSER_ALT_ALLELE_DIR", str(path))
    return path


def _fasta_named(fixture, directory, name):
    """The fixture's reference under another file name (with its index)."""
    os.makedirs(directory, exist_ok=True)
    dest = os.path.join(str(directory), name)
    shutil.copy(fixture["fasta"], dest)
    shutil.copy(fixture["fasta"] + ".fai", dest + ".fai")
    return dest


def _fresh():
    from state.browser_state import BrowserState
    return BrowserState(None, None, None, None)


def _analyze(state, dataset_id, chrom, start, end):
    from models.requests import FootprintAnalysisRequest
    from services.footprint_endpoint import analyze_footprints_payload
    req = FootprintAnalysisRequest(
        footprints=[{"absStart": start + 40, "absEnd": start + 70, "size": 30, "readId": "__ref__", "datasetId": dataset_id}],
        dataset_ids=[dataset_id], include_read_analysis=False, include_overlap=False, include_overlap_sizes=False,
        include_profiles=False, include_vplot=False, include_coocc=False, pinned_defaults=True)
    return analyze_footprints_payload(state, chrom=chrom, region_start=start, region_end=end, spanning=False, request=req)


def _alt_on_panel_reference(fixture, tmp_path, fasta_name, declare=None):
    """An alt allele built from a source whose reference is a panel FASTA (not the main genome)."""
    from services import panel_genomes
    from services.alt_allele import open_alt_allele
    state = _fresh()
    state.add_dataset("ins", fixture["bam"], label="insertion")
    attached = panel_genomes.attach(state, ["ins"], fasta_path=_fasta_named(fixture, tmp_path / "ref", fasta_name), span=0)
    if declare:
        motifs.declare_genome(panel_genomes.genome_view(state, attached["genome"]["key"]), declare)
    result = open_alt_allele(state, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000})
    return state, result, panel_genomes.genome_view(state, result["genome_key"])


def test_the_alt_allele_inherits_the_source_genome(fixture, alt_dir, tmp_path):
    state, result, view = _alt_on_panel_reference(fixture, tmp_path, "hg38.fa")
    assert motifs.reference_genome_basis(view) == ("hg38", "inherited")
    assert motifs.jaspar_genome(view) == ("hg38", False)
    assert motifs.genome_taxon(motifs.jaspar_genome(view)[0]) == "vertebrates"
    # Its coordinates are its own: the contig, not the genome's chromosomes, and no genes on it.
    assert [c.name for c in view.chroms] == [result["layout"]["name"]]
    assert not (getattr(view, "gtf_data", None) or {}).get("transcripts")
    # The main state is untouched (no genome of its own).
    assert getattr(state, "current_genome", None) is None and motifs.reference_genome(state) is None


def test_the_alt_allele_inherits_a_genome_declared_for_the_source_fasta(fixture, alt_dir, tmp_path):
    _state, _result, view = _alt_on_panel_reference(fixture, tmp_path, "custom_ref.fa", declare="mm10")
    assert motifs.reference_genome_basis(view) == ("mm10", "inherited")
    assert motifs.jaspar_genome(view) == ("mm10", False)


def test_the_alt_allele_inherits_an_assembly_identified_by_its_lengths(fixture, alt_dir, tmp_path):
    """A source FASTA not named for its genome, whose chromosome lengths identify it (the spec's assembly)."""
    from services import panel_genomes
    from services.alt_allele import open_alt_allele
    state = _fresh()
    state.add_dataset("ins", fixture["bam"], label="insertion")
    attached = panel_genomes.attach(state, ["ins"], fasta_path=_fasta_named(fixture, tmp_path / "ref", "GRCh38_custom.fa"), span=0)
    ctx = panel_genomes.contexts(state)[attached["genome"]["key"]]
    assert getattr(ctx, "current_genome", None) is None
    ctx._panel_genome_spec["assembly"] = "hg38"  # as services/genome_check.loaded_reference reports for real hg38 lengths
    result = open_alt_allele(state, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000})
    view = panel_genomes.genome_view(state, result["genome_key"])
    assert motifs.reference_genome_basis(view) == ("hg38", "inherited")


def test_an_unidentified_source_leaves_the_alt_allele_without_a_genome(fixture, alt_dir, tmp_path):
    _state, _result, view = _alt_on_panel_reference(fixture, tmp_path, "custom_ref.fa")
    assert motifs.jaspar_genome(view) == (None, False)


def test_genes_on_the_alt_contig_are_empty_not_an_error(fixture, alt_dir, tmp_path, client):
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion"})
    source = resp.json()["dataset"]
    alt_id = None
    try:
        data = client.post("/api/alt_allele/open", json={"dataset_id": source["id"], "chrom": "chrT",
                                                          "ref": SITE, "length": 2010, "flank": 2000}).json()
        assert data["success"], data
        alt_id = data["dataset"]["id"]
        resp = client.get("/api/genes", params={"chrom": data["layout"]["name"], "start": 0, "end": 4000,
                                                "panel_genome": data["genome_key"]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert not (body.get("genes") if isinstance(body, dict) else body)
    finally:
        if alt_id:
            client.delete(f"/api/datasets/{alt_id}")
        client.delete(f"/api/datasets/{source['id']}")


@needs_jaspar
def test_motif_scan_on_the_expanded_insert_uses_the_source_species(fixture, alt_dir, tmp_path):
    state, result, _view = _alt_on_panel_reference(fixture, tmp_path, "hg38.fa")
    layout = result["layout"]
    out = _analyze(state, result["dataset"]["id"], layout["name"], layout["insert_start"], layout["insert_start"] + 200)
    species = out["jaspar_species"]
    assert species["genome"] == "hg38" and species["name"] == "human" and species.get("inherited") is True
    assert not any("No genome" in w for w in out.get("warnings", []))
    assert out["footprints"][0]["sequence"]  # the insert's own bases


@needs_jaspar
def test_a_custom_fasta_falls_back_to_vertebrates_then_takes_a_declared_genome(fixture, tmp_path):
    state = _fresh()
    assert state._load_fasta(_fasta_named(fixture, tmp_path, "my_contig.fa")) is None
    state.add_dataset("ins", fixture["bam"], label="insertion")
    out = _analyze(state, "ins", "chrT", SITE - 100, SITE + 100)
    assert out["jaspar_species"]["fallback"] is True and out["jaspar_species"]["name"] == "vertebrates"
    assert motifs.FALLBACK_NOTE in out["warnings"]
    assert not any("No genome selected" in w for w in out["warnings"])
    assert any(src["source"] == "jaspar" for src in out.get("motif_sources", [])) or out["motif_pwms"]

    motifs.declare_genome(state, "hg38")
    out = _analyze(state, "ins", "chrT", SITE - 100, SITE + 100)
    assert out["jaspar_species"]["genome"] == "hg38" and out["jaspar_species"].get("declared") is True
    assert motifs.FALLBACK_NOTE not in out["warnings"]
    # Declared for that file only: another FASTA does not inherit it.
    assert state._load_fasta(_fasta_named(fixture, tmp_path, "other_contig.fa")) is None
    assert motifs.declared_genome(state) is None


@needs_jaspar
def test_the_class_catalogue_falls_back_too(fixture, tmp_path):
    from services import motif_scoring
    state = _fresh()
    assert state._load_fasta(_fasta_named(fixture, tmp_path, "my_contig.fa")) is None
    records, species, _pinned, warnings = motif_scoring.catalogue(state)
    assert species["fallback"] and records and motifs.FALLBACK_NOTE in warnings
    assert {r["matrix_id"].split(".")[0] for r in records} >= {"MA0139"}  # CTCF is a vertebrate matrix


def test_a_declared_genome_survives_a_session(fixture, tmp_path):
    from models.requests import SessionExportRequest, SessionImportRequest
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    state = _fresh()
    fasta = _fasta_named(fixture, tmp_path, "my_contig.fa")
    assert state._load_fasta(fasta) is None
    motifs.declare_genome(state, "hg38")
    session = build_session_export_for_request(state, SessionExportRequest(chrom="chrT", start=0, end=1000))["session"]
    session = json.loads(json.dumps(session, default=str))
    assert session["reference"]["genome_declarations"] == [{"fasta_path": os.path.abspath(fasta), "genome": "hg38"}]
    fresh = _fresh()
    fresh.genome_declarations = {"/elsewhere.fa": "dm6"}  # the previous session's: replaced
    import_session_for_request(fresh, SessionImportRequest(session=session))
    assert fresh.genome_declarations == {os.path.abspath(fasta): "hg38"}
    assert motifs.jaspar_genome(fresh) == ("hg38", False)


def test_declare_genome_endpoint(client, fixture, tmp_path):
    resp = client.post("/api/reference/declare_genome", json={"genome": "notagenome"})
    assert resp.status_code == 404
    # a panel's reference by its key
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion"})
    source = resp.json()["dataset"]
    try:
        attached = client.post("/api/panel_genomes/attach", json={
            "dataset_ids": [source["id"]], "fasta_path": _fasta_named(fixture, tmp_path, "panel_contig.fa"), "span": 0}).json()
        key = attached["genome"]["key"]
        out = client.post("/api/reference/declare_genome", params={"panel_genome": key}, json={"genome": "dm6"}).json()
        assert out["success"] and out["genome"] == "dm6" and out["jaspar_species"]["name"] == "fly"
        search = client.get("/api/motifs/jaspar/search", params={"q": "CTCF", "panel_genome": key}).json()
        if search["available"]:
            assert search["results"][0]["tax_group"] == "insects"
        cleared = client.post("/api/reference/declare_genome", params={"panel_genome": key}, json={"genome": None}).json()
        assert cleared["success"] and cleared["genome"] is None
    finally:
        client.post("/api/panel_genomes/detach", json={"dataset_ids": [source["id"]]})
        client.delete(f"/api/datasets/{source['id']}")


# ---------------------------------------------------------------------------------------------------------------
# Transitions: declare, redeclare, clear, relink, several panels


def _meta_genome(result):
    with open(os.path.join(os.path.dirname(result["dataset"]["path"]), "meta.json")) as fh:
        return (json.load(fh).get("source") or {}).get("genome")


def test_an_open_insert_follows_its_sources_declaration_declare_redeclare_clear(fixture, alt_dir, tmp_path):
    from services import panel_genomes
    state, result, view = _alt_on_panel_reference(fixture, tmp_path, "custom_ref.fa")
    source_view = panel_genomes.for_datasets(state, ["ins"])
    alt_ctx = panel_genomes.contexts(state)[result["genome_key"]]
    assert motifs.reference_genome(view) is None and _meta_genome(result) is None
    rev0 = motifs.declaration_revision(state)
    motifs.declare_genome(source_view, "mm10")
    assert motifs.reference_genome_basis(panel_genomes.genome_view(state, result["genome_key"])) == ("mm10", "inherited")
    assert _meta_genome(result) == "mm10" and motifs.declaration_revision(state) == rev0 + 1
    motifs.declare_genome(source_view, "dm6")
    assert motifs.jaspar_genome(panel_genomes.genome_view(state, result["genome_key"])) == ("dm6", False)
    assert _meta_genome(result) == "dm6"
    motifs.declare_genome(source_view, None)
    assert "species_genome" not in alt_ctx._panel_genome_spec          # removed, not left stale
    assert motifs.reference_genome(panel_genomes.genome_view(state, result["genome_key"])) is None
    assert _meta_genome(result) is None
    # Reopening the insert after the clear: still none (the built metadata does not bring it back).
    from services.alt_allele import describe_fasta_context, open_alt_allele
    open_alt_allele(state, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000})
    describe_fasta_context(alt_ctx, alt_ctx.fasta_path)
    assert "species_genome" not in alt_ctx._panel_genome_spec


def test_a_declared_genome_is_a_species_not_coordinates(fixture, tmp_path):
    """Declared hg38 on a custom FASTA: hg38's species (JASPAR, TE library) but no coordinate assembly (UCSC
    lookups); results and staleness keys change with each declaration."""
    from services import insertion_identify as ii
    state = _fresh()
    assert state._load_fasta(_fasta_named(fixture, tmp_path, "my_contig.fa")) is None
    keys = [(ii.reference_id(state), ii.genome_signature(state, "blast"), motifs.genome_identity_key(state))]
    for genome in ("hg38", "hg19", None):
        motifs.declare_genome(state, genome)
        assert motifs.reference_genome(state) == genome
        assert motifs.coordinate_genome(state) is None
        assert ii.StateSnapshot(state).coordinate_genome is None
        keys.append((ii.reference_id(state), ii.genome_signature(state, "blast"), motifs.genome_identity_key(state)))
    for i in range(3):
        assert len({k[i] for k in keys}) == len(keys), keys      # every declaration (and the clear) is a new key


def test_a_loaded_genome_is_its_coordinate_assembly(fixture, tmp_path):
    from services import insertion_identify as ii
    state = _fresh()
    assert state._load_fasta(_fasta_named(fixture, tmp_path, "hg38.fa")) is None   # named for it: the loaded genome
    assert motifs.coordinate_genome(state) == "hg38" and ii.StateSnapshot(state).coordinate_genome == "hg38"


def test_relinking_a_session_carries_the_declaration(fixture, tmp_path):
    from models.requests import SessionExportRequest, SessionImportRequest
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    old = _fasta_named(fixture, tmp_path / "old", "contig.fa")
    new = _fasta_named(fixture, tmp_path / "new", "contig.fa")
    state = _fresh()
    assert state._load_fasta(old) is None
    motifs.declare_genome(state, "dm6")
    session = json.loads(json.dumps(build_session_export_for_request(
        state, SessionExportRequest(chrom="chrT", start=0, end=1000))["session"], default=str))
    for sess in (session, {**session, "reference": {**session["reference"],
                                                   "genome_declarations": {os.path.abspath(old): "dm6"}}}):  # older form
        fresh = _fresh()
        import_session_for_request(fresh, SessionImportRequest(session=sess, path_mapping={os.path.abspath(old): new}))
        assert fresh.fasta_path == new
        assert fresh.genome_declarations == {os.path.abspath(new): "dm6"}
        assert motifs.jaspar_genome(fresh) == ("dm6", False)


def test_several_panels_keep_their_own_genomes(fixture, alt_dir, tmp_path, client):
    """Two sources on two custom panel FASTAs declared mouse and fly, each with its expanded insert: every insert and
    every panel resolves its own species, and JASPAR search ranks for the panel it is asked for."""
    from services import panel_genomes
    from services.alt_allele import open_alt_allele
    state = _fresh()
    keys = {}
    for name, genome, fasta in (("a", "mm10", "mouse_contig.fa"), ("b", "dm6", "fly_contig.fa")):
        state.add_dataset(name, fixture["bam"], label=name)
        attached = panel_genomes.attach(state, [name], fasta_path=_fasta_named(fixture, tmp_path / name, fasta), span=0)
        motifs.declare_genome(panel_genomes.genome_view(state, attached["genome"]["key"]), genome)
        keys[name] = open_alt_allele(state, name, {"chrom": "chrT", "pos": SITE, "flank": 3000})["genome_key"]
    assert motifs.jaspar_genome(panel_genomes.genome_view(state, keys["a"]))[0] == "mm10"
    assert motifs.jaspar_genome(panel_genomes.genome_view(state, keys["b"]))[0] == "dm6"
    # the main reference (none) is untouched
    assert motifs.jaspar_genome(state) == (None, False)

    # JASPAR search over the API: panel references declared differently rank their own taxon first.
    added = []
    try:
        for name, genome in (("p1", "mm10"), ("p2", "dm6")):
            ds = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": name}).json()["dataset"]
            added.append(ds["id"])
            key = client.post("/api/panel_genomes/attach", json={
                "dataset_ids": [ds["id"]], "fasta_path": _fasta_named(fixture, tmp_path / name, f"{name}.fa"), "span": 0}).json()["genome"]["key"]
            assert client.post("/api/reference/declare_genome", params={"panel_genome": key}, json={"genome": genome}).json()["success"]
            search = client.get("/api/motifs/jaspar/search", params={"q": "CTCF", "panel_genome": key}).json()
            if search["available"]:
                assert search["results"][0]["tax_group"] == ("vertebrates" if genome == "mm10" else "insects")
    finally:
        for did in added:
            client.post("/api/panel_genomes/detach", json={"dataset_ids": [did]})
            client.delete(f"/api/datasets/{did}")


def test_an_insert_removed_before_its_source_is_cleared_reopens_without_the_old_genome(fixture, alt_dir, tmp_path):
    """The insert is closed when the source's declaration is cleared (nothing open to refresh); reopening reuses
    the cached build, whose metadata must follow the source now, and attaching that build's FASTA again (a
    session, a crash restore: describe_fasta_context) must not bring the old genome back."""
    from services import panel_genomes
    from services.alt_allele import describe_fasta_context, open_alt_allele
    state, result, view = _alt_on_panel_reference(fixture, tmp_path, "custom_ref.fa", declare="hg38")
    assert motifs.reference_genome_basis(view) == ("hg38", "inherited") and _meta_genome(result) == "hg38"
    alt_id = result["dataset"]["id"]
    panel_genomes.detach(state, [alt_id])
    state.remove_dataset(alt_id)
    motifs.declare_genome(panel_genomes.for_datasets(state, ["ins"]), None)     # cleared while the insert is closed
    assert _meta_genome(result) == "hg38"                                     # (nothing open to refresh)
    again = open_alt_allele(state, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000})
    assert again["dataset"]["path"] == result["dataset"]["path"]               # the cached build, reused
    assert _meta_genome(again) is None
    ctx = panel_genomes.contexts(state)[again["genome_key"]]
    assert "species_genome" not in ctx._panel_genome_spec
    describe_fasta_context(ctx, ctx.fasta_path)
    assert "species_genome" not in ctx._panel_genome_spec
    assert motifs.reference_genome(panel_genomes.genome_view(state, again["genome_key"])) is None


def test_swapped_relinks_keep_each_declaration_with_its_file(fixture, tmp_path):
    """Relinking /a -> /b and /b -> /a (the files swapped): each declaration moves once, with its file."""
    from models.requests import SessionExportRequest, SessionImportRequest
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    a = os.path.abspath(_fasta_named(fixture, tmp_path / "a", "contig.fa"))
    b = os.path.abspath(_fasta_named(fixture, tmp_path / "b", "contig.fa"))
    state = _fresh()
    assert state._load_fasta(a) is None
    motifs.declare_genome(state, "hg38")
    session = json.loads(json.dumps(build_session_export_for_request(
        state, SessionExportRequest(chrom="chrT", start=0, end=1000))["session"], default=str))
    session["reference"]["genome_declarations"].append({"fasta_path": b, "genome": "dm6"})
    legacy = {**session, "reference": {**session["reference"], "genome_declarations": {a: "hg38", b: "dm6"}}}
    for sess in (session, legacy):
        fresh = _fresh()
        import_session_for_request(fresh, SessionImportRequest(session=sess, path_mapping={a: b, b: a}))
        assert fresh.fasta_path == b
        assert fresh.genome_declarations == {b: "hg38", a: "dm6"}
        assert motifs.jaspar_genome(fresh) == ("hg38", False)


def test_the_te_library_route_accepts_the_reference_revision(client):
    """The Identify tab sends reference_revision (it keeps a pending request for an earlier declaration from being
    shared): the route answers as without it."""
    plain = client.get("/api/insertions/te_library")
    tagged = client.get("/api/insertions/te_library", params={"reference_revision": 3})
    assert plain.status_code == tagged.status_code == 200
    assert tagged.json()["success"] and tagged.json()["reference_id"] == plain.json()["reference_id"]
