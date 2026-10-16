"""A plasmid map and a BAM aligned to a renamed or rotated copy of it are linked by sequence.

Synthetic plasmids: a GenBank map, a FASTA (renamed / rotated / different) and
a BAM of exact reads carrying MD tags, with optional @SQ M5, aligner @PG line
naming the FASTA, and @CO FIBERHMM-REFERENCE declaration.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import random

import pysam
import pytest

from utils.chrom import get_chrom_variants, resolve_reference_name

L = 3000


def _seq(seed: int, length: int = L) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice("ACGT") for _ in range(length))


def _rot(seq: str, offset: int) -> str:
    return seq[offset:] + seq[:offset]


def write_map(path, name: str, seq: str, features=((0, 400, "ori"), (1000, 1600, "geneA"))):
    lines = [f"LOCUS       {name:<16}{len(seq)} bp    DNA     circular SYN 01-JAN-2000",
             "FEATURES             Location/Qualifiers"]
    for start, end, label in features:
        lines.append(f"     misc_feature    {start + 1}..{end}")
        lines.append(f'                     /label="{label}"')
    lines.append("ORIGIN")
    for i in range(0, len(seq), 60):
        lines.append(f"{i + 1:>9} {seq[i:i + 60].lower()}")
    lines.append("//")
    path.write_text("\n".join(lines) + "\n")
    return str(path)


def write_fasta(path, contig: str, seq: str, index: bool = True):
    path.write_text(f">{contig}\n" + "\n".join(seq[i:i + 60] for i in range(0, len(seq), 60)) + "\n")
    if index:
        pysam.faidx(str(path))
    return str(path)


def write_bam(path, contig: str, ref_seq: str, *, m5: bool = False, fasta: str | None = None,
              comments=(), md: bool = True, n_reads: int = 12):
    sq = {"SN": contig, "LN": len(ref_seq)}
    if m5:
        sq["M5"] = hashlib.md5(ref_seq.upper().encode()).hexdigest()
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [sq]}
    if fasta:
        header["PG"] = [{"ID": "minimap2", "PN": "minimap2",
                         "CL": f"minimap2 -ax map-ont --MD {fasta} reads.fastq.gz"}]
    if comments:
        header["CO"] = list(comments)
    unsorted = str(path) + ".unsorted.bam"
    rng = random.Random(7)
    starts = sorted(rng.randrange(0, len(ref_seq) - 500) for _ in range(n_reads))
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for i, start in enumerate(starts):
            length = 400
            read = pysam.AlignedSegment(out.header)
            read.query_name = f"r{i}"
            read.reference_id = 0
            read.reference_start = start
            read.mapping_quality = 60
            read.cigarstring = f"{length}M"
            read.query_sequence = ref_seq[start:start + length]
            read.query_qualities = pysam.qualitystring_to_array("I" * length)
            if md:
                read.set_tag("MD", str(length))
            out.write(read)
    pysam.sort("-o", str(path), unsorted)
    os.remove(unsorted)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def state():
    from state.browser_state import BrowserState
    return BrowserState(None, None, None, None)


def load_map(state, path):
    from routers.genome import load_plasmid_endpoint
    return asyncio.run(load_plasmid_endpoint(path=path, state=state))


def features(state, chrom):
    tx = state.gtf_data["transcripts"]
    rows = tx[tx["chrom"] == chrom]
    return {row.gene_name: (int(row.start), int(row.end)) for row in rows.itertuples()}


def test_renamed_contig_is_linked_and_reads_resolve(tmp_path, state):
    seq = _seq(1)
    map_path = write_map(tmp_path / "pRenamed.gb", "pRenamed", seq)
    fasta = write_fasta(tmp_path / "aligned.fasta", "t", seq)
    bam = write_bam(tmp_path / "reads.bam", "t", seq, fasta=fasta)
    assert load_map(state, map_path)["success"]

    dataset = state.add_dataset("reads", bam)

    link = dataset.plasmid_report["links"][0]
    assert (link["contig"], link["chrom"], link["offset"], link["method"]) == ("t", "pRenamed", 0, "reference")
    assert link["verified"] is True
    # The link is this workspace's and this dataset's, not a process-wide name alias.
    from services.plasmid_reconcile import contig_links
    assert "t" not in get_chrom_variants("pRenamed")
    links = contig_links(state, dataset_id="reads")
    assert links == {"t": "pRenamed"} and contig_links(state, path=bam) == links
    with pysam.AlignmentFile(bam) as handle:
        assert resolve_reference_name("pRenamed", handle.references) is None
        assert resolve_reference_name("pRenamed", handle.references, links=links) == "t"
    assert len(state.get_reads("pRenamed", 0, L, False, "reads")) > 0
    from services.dataset_contigs import datasets_with_contig
    assert datasets_with_contig(state, "pRenamed") == ["reads"]
    assert dataset.to_dict()["plasmid"]["links"][0]["chrom"] == "pRenamed"


def test_rotated_reference_reframes_the_map(tmp_path, state):
    seq = _seq(2)
    offset = 295
    map_path = write_map(tmp_path / "pRot.gb", "pRot", seq)
    fasta = write_fasta(tmp_path / "pRot_orirot.fasta", "pRot_orirot", _rot(seq, offset))
    bam = write_bam(tmp_path / "rot.bam", "pRot_orirot", _rot(seq, offset), fasta=fasta)
    load_map(state, map_path)

    dataset = state.add_dataset("rot", bam)

    link = dataset.plasmid_report["links"][0]
    assert (link["chrom"], link["offset"], link["method"]) == ("pRot", offset, "reference")
    # The map is shown in the BAM's frame: same sequence, features moved with it.
    assert state.plasmid_sequences["pRot"] == _rot(seq, offset)
    assert state.plasmid_metadata["pRot"]["frame_offset"] == offset
    feats = features(state, "pRot")
    assert feats["ori"] == (L - offset, L - offset + 400)   # across the new origin
    assert feats["geneA"] == (1000 - offset, 1600 - offset)
    # Its part after the origin is found by a window at the start.
    from services.read_auxiliary_endpoint import get_genes_payload
    genes = get_genes_payload(state, chrom="pRot", start=0, end=200)["content"]["genes"]
    assert [(g["name"], g["start"], g["end"]) for g in genes] == [("ori", -offset, 400 - offset)]


def test_rotation_found_from_read_md_tags_without_fasta(tmp_path, state):
    seq = _seq(3)
    load_map(state, write_map(tmp_path / "pReads.gb", "pReads", seq))
    bam = write_bam(tmp_path / "reads.bam", "other_name", _rot(seq, 1234))

    link = state.add_dataset("reads", bam).plasmid_report["links"][0]

    assert (link["offset"], link["method"], link["verified"]) == (1234, "reads", True)


def test_m5_match(tmp_path, state):
    seq = _seq(4)
    load_map(state, write_map(tmp_path / "pM5.gb", "pM5", seq))
    bam = write_bam(tmp_path / "m5.bam", "contig_1", seq, m5=True, md=False)

    link = state.add_dataset("m5", bam).plasmid_report["links"][0]

    assert (link["contig"], link["offset"], link["method"]) == ("contig_1", 0, "m5")


def test_map_loaded_after_the_bam_links_and_drops_the_bare_contig(tmp_path, state):
    seq = _seq(5)
    bam = write_bam(tmp_path / "first.bam", "D_orirot", _rot(seq, 100))
    state.add_dataset("first", bam)
    assert [c.name for c in state.chroms] == ["D_orirot"]

    result = load_map(state, write_map(tmp_path / "D.gb", "D", seq))

    assert result["links"][0]["offset"] == 100
    # The BAM's contig is now shown as the map (no duplicate linear chromosome).
    assert [c.name for c in state.chroms] == ["D"]


def test_no_match_messages_name_what_differs(tmp_path, state):
    seq = _seq(6)
    load_map(state, write_map(tmp_path / "pMap.gb", "pMap", seq))
    shorter = write_bam(tmp_path / "short.bam", "pOther", _seq(9, 2500))
    ds = state.add_dataset("short", shorter)
    problem = ds.plasmid_report["problems"][0]
    assert problem["kind"] == "length"
    assert "2,500 bp" in problem["message"] and "3,000 bp" in problem["message"]

    mutated = list(_rot(seq, 40))
    for pos in (500, 900):
        mutated[pos] = "A" if mutated[pos] != "A" else "C"
    mutated = "".join(mutated)
    fasta = write_fasta(tmp_path / "mut.fasta", "pMut", mutated)
    ds = state.add_dataset("mut", write_bam(tmp_path / "mut.bam", "pMut", mutated, fasta=fasta, md=False))
    problem = ds.plasmid_report["problems"][0]
    assert problem["kind"] == "sequence" and problem["differences"] == 2 and problem["offset"] == 40
    assert "pMut:501" in problem["message"] and problem["can_confirm"]
    assert not ds.plasmid_report.get("links")

    rc = write_fasta(tmp_path / "rc.fasta", "pRc", seq[::-1].translate(str.maketrans("ACGT", "TGCA")))
    ds = state.add_dataset("rc", write_bam(tmp_path / "rc.bam", "pRc", "A" * L, fasta=rc, md=False))
    assert ds.plasmid_report["problems"][0]["kind"] == "reverse_complement"


def test_unverifiable_same_length_contig_is_linked_on_confirmation(tmp_path, state):
    from routers.genome import confirm_plasmid_link_endpoint
    seq = _seq(7)
    load_map(state, write_map(tmp_path / "pConf.gb", "pConf", seq))
    ds = state.add_dataset("conf", write_bam(tmp_path / "conf.bam", "unknown", seq, md=False))
    problem = ds.plasmid_report["problems"][0]
    assert problem["kind"] == "unverified" and problem["can_confirm"]

    result = asyncio.run(confirm_plasmid_link_endpoint(chrom="pConf", dataset_id="conf", contig="unknown",
                                                       offset=0, state=state))

    assert result["success"] and result["link"]["method"] == "confirmed"
    from services.plasmid_reconcile import contig_links
    assert contig_links(state, dataset_id="conf") == {"unknown": "pConf"}
    assert result["problems"] == []


def test_second_bam_in_another_frame_gets_its_own_copy(tmp_path, state):
    seq = _seq(8)
    load_map(state, write_map(tmp_path / "pTwo.gb", "pTwo", seq))
    state.add_dataset("same", write_bam(tmp_path / "same.bam", "pTwo_ref", seq))
    other = state.add_dataset("rot", write_bam(tmp_path / "rot.bam", "pTwo_rot", _rot(seq, 700)))

    link = other.plasmid_report["links"][0]
    assert link["chrom"] == "pTwo_rot" and link["offset"] == 700
    assert state.plasmid_sequences["pTwo"] == seq           # the first frame is kept
    assert state.plasmid_sequences["pTwo_rot"] == _rot(seq, 700)
    assert state.plasmid_metadata["pTwo_rot"]["map_chrom"] == "pTwo"
    assert features(state, "pTwo_rot")["geneA"] == (300, 900)


def test_header_declaration_loads_the_map_next_to_the_bam(tmp_path, state):
    seq = _seq(10)
    write_map(tmp_path / "pDecl.gb", "pDecl", seq)
    md5 = hashlib.md5(seq.encode()).hexdigest()
    bam = write_bam(tmp_path / "decl.bam", "pDecl_aln", seq, md=False,
                    comments=[f"FIBERHMM-REFERENCE:v1:map=pDecl.gb;contig=pDecl_aln;circular=1;map_md5={md5}"])

    ds = state.add_dataset("decl", bam)

    assert ds.plasmid_report["maps_loaded"][0]["name"] == "pDecl"
    link = ds.plasmid_report["links"][0]
    assert (link["chrom"], link["contig"], link["method"]) == ("pDecl", "pDecl_aln", "header")


def test_fiberhmm_pipeline_header_loads_its_map_copy(tmp_path, state):
    # fiberhmm-pipeline's form: percent-encoded values, the map copied next to the BAM.
    seq = _seq(14)
    map_file = tmp_path / "pPipe v2.gb"
    write_map(map_file, "pPipe", seq)
    sha = hashlib.sha256(map_file.read_bytes()).hexdigest()
    md5 = hashlib.md5(seq.encode()).hexdigest()
    comment = (f"FIBERHMM-REFERENCE:v1:contig=pPipe;length={L};md5={md5};topology=circular;"
               f"source=pPipe%20v2.gb;source_format=genbank;source_sha256={sha}")
    bam = write_bam(tmp_path / "sample.fiberhmm.bam", "pPipe", seq, m5=True, md=False, comments=[comment])

    ds = state.add_dataset("pipe", bam)

    assert ds.plasmid_report["maps_loaded"][0]["path"] == str(map_file)
    assert ds.plasmid_report["links"][0]["method"] == "m5"
    # A map edited since the run is not loaded silently.
    map_file.write_text(map_file.read_text().replace("misc_feature", "gene        "))
    from state.browser_state import BrowserState
    ds = BrowserState(None, None, None, None).add_dataset("pipe", bam)
    assert "has changed" in ds.plasmid_report["maps_loaded"][0]["error"]


def test_parse_reference_comments_keeps_paths_with_spaces():
    from services.plasmid_reconcile import parse_reference_comments
    header = {"CO": ["MA-TYPES:v1:nuc", "FIBERHMM-REFERENCE:v1:map=/x/YX8KMM_results (1)/D map.gbk;contig=D;circular=1;map_md5=ABC"]}
    assert parse_reference_comments(header) == [
        {"map": "/x/YX8KMM_results (1)/D map.gbk", "contig": "D", "circular": "1", "map_md5": "ABC"}]
    pipeline = {"CO": ["FIBERHMM-REFERENCE:v1:contig=D;length=9;md5=abc;topology=linear;source=D%20(1).dna;"
                       "source_format=snapgene;source_sha256=00"]}
    entry = parse_reference_comments(pipeline)[0]
    assert (entry["map"], entry["map_md5"], entry["circular"]) == ("D (1).dna", "abc", "0")
    fasta_ref = {"CO": ["FIBERHMM-REFERENCE:v1:contig=chrM;md5=abc;topology=circular;source=dm6.fa;source_format=fasta"]}
    assert "map" not in parse_reference_comments(fasta_ref)[0]


def test_session_keeps_links_and_frames(tmp_path, state):
    from services.sessions_endpoint import _plasmid_links
    from services.plasmid_reconcile import restore_session_links
    from state.browser_state import BrowserState
    seq = _seq(11)
    map_path = write_map(tmp_path / "pSess.gb", "pSess", seq)
    load_map(state, map_path)
    state.add_dataset("rot", write_bam(tmp_path / "rot.bam", "pSess_rot", _rot(seq, 50)))
    state.add_dataset("conf", write_bam(tmp_path / "conf.bam", "nomd", _rot(seq, 50), md=False))
    from routers.genome import confirm_plasmid_link_endpoint
    asyncio.run(confirm_plasmid_link_endpoint(chrom="pSess", dataset_id="conf", contig="nomd", offset=50, state=state))
    saved = _plasmid_links(state)
    assert {(l["contig"], l["offset"], l["method"]) for l in saved} == {("pSess_rot", 50, "reads"), ("nomd", 50, "confirmed")}

    restored = BrowserState(None, None, None, None)
    restored.add_dataset("rot", str(tmp_path / "rot.bam"))
    restored.add_dataset("conf", str(tmp_path / "conf.bam"))
    load_map(restored, map_path)  # (the session restore loads maps without linking)
    restore_session_links(restored, saved)

    assert restored.plasmid_sequences["pSess"] == _rot(seq, 50)
    links = {l["contig"]: l for l in restored.plasmid_metadata["pSess"]["links"]}
    assert links["nomd"]["method"] == "confirmed" and links["pSess_rot"]["offset"] == 50


def test_open_plasmid_dataset_endpoint(tmp_path, state):
    from routers.genome import open_plasmid_dataset_endpoint
    seq = _seq(12)
    map_path = write_map(tmp_path / "pOpen.gb", "pOpen", seq)
    fasta = write_fasta(tmp_path / "open_ref.fa", "open_ref", _rot(seq, 10), index=False)
    bam = write_bam(tmp_path / "open.bam", "open_ref", _rot(seq, 10), md=False)
    other = write_bam(tmp_path / "other.bam", "elsewhere", _seq(13, 1000))

    result = asyncio.run(open_plasmid_dataset_endpoint(map_path=map_path, bam_paths=[bam, other],
                                                       reference_fasta=fasta, state=state))

    assert result["success"] and result["chrom"] == "pOpen"
    assert [(l["contig"], l["offset"], l["method"]) for l in result["links"]] == [("open_ref", 10, "reference")]
    assert [p["kind"] for p in result["problems"]] == ["length"]
    assert not os.path.exists(fasta + ".fai")  # the user's FASTA is read, never indexed


# --- the post-add map load publishes under the state lock (fb62) --------------------------------------------


def _declared_bam(tmp_path, name="pLock"):
    seq = _seq(21)
    write_map(tmp_path / f"{name}.gb", name, seq)
    md5 = hashlib.md5(seq.encode()).hexdigest()
    return write_bam(tmp_path / f"{name}.bam", f"{name}_aln", seq, md=False,
                     comments=[f"FIBERHMM-REFERENCE:v1:map={name}.gb;contig={name}_aln;circular=1;map_md5={md5}"])


def _added_without_autoload(state, monkeypatch, dataset_id, bam):
    import services.plasmid_reconcile as pr
    with pytest.MonkeyPatch().context() as patch:
        patch.setattr(pr, "after_dataset_added", lambda *a, **k: {})
        return state.add_dataset(dataset_id, bam)


def test_a_declared_map_is_parsed_outside_the_state_lock_and_published_under_it(tmp_path, state, monkeypatch):
    import threading
    import services.plasmid_maps as maps
    from services.genome_loading import state_lock
    from services.plasmid_reconcile import autoload_declared_maps
    dataset = _added_without_autoload(state, monkeypatch, "decl", _declared_bam(tmp_path))
    parsed = threading.Event()
    real = maps.parse_plasmid_map

    def parse(path):
        result = real(path)
        parsed.set()
        return result
    monkeypatch.setattr(maps, "parse_plasmid_map", parse)
    out = []
    with state_lock(state):
        loader = threading.Thread(target=lambda: out.extend(autoload_declared_maps(state, dataset)))
        loader.start()
        assert parsed.wait(5)                                # read and parsed while the lock is held elsewhere
        loader.join(0.3)
        assert loader.is_alive() and "pLock" not in (state.plasmid_sequences or {})   # publication waits
    loader.join(5)
    assert out and out[0]["name"] == "pLock" and "pLock" in state.plasmid_sequences


def test_a_map_is_not_published_for_a_dataset_removed_meanwhile(tmp_path, state, monkeypatch):
    import services.plasmid_maps as maps
    from services.plasmid_reconcile import autoload_declared_maps
    dataset = _added_without_autoload(state, monkeypatch, "decl", _declared_bam(tmp_path))
    real = maps.parse_plasmid_map

    def parse(path):
        result = real(path)
        state.remove_dataset("decl")                         # removed while its map was being read
        return result
    monkeypatch.setattr(maps, "parse_plasmid_map", parse)
    assert autoload_declared_maps(state, dataset) == []
    assert "pLock" not in (state.plasmid_sequences or {})


def test_a_map_a_newer_load_published_meanwhile_is_not_loaded_twice(tmp_path, state, monkeypatch):
    import services.plasmid_maps as maps
    from services.plasmid_reconcile import autoload_declared_maps
    bam = _declared_bam(tmp_path)
    dataset = _added_without_autoload(state, monkeypatch, "decl", bam)
    real = maps.parse_plasmid_map

    def parse(path):
        result = real(path)
        load_map(state, str(tmp_path / "pLock.gb"))         # the same map, loaded by another request meanwhile
        return result
    monkeypatch.setattr(maps, "parse_plasmid_map", parse)
    before_gtf = None
    assert autoload_declared_maps(state, dataset) == []
    assert [n for n in state.plasmid_sequences if n.startswith("pLock")] == ["pLock"]
    assert features(state, "pLock")["geneA"] == (1000, 1600)
