"""A plasmid link belongs to one workspace, one dataset's files and one frame.

Reproductions from the 29 Sep review: a link made in workspace A (map
``aliasMap`` <- contig ``genericAlias``) was a process-wide name alias, so an
unrelated BAM with that contig name in workspace B showed its reads on the
map; and in one workspace two BAMs with the same contig name in different
frames both resolved on the map's original frame.
"""
from __future__ import annotations

import pytest

from test_plasmid_reconcile import L, _rot, _seq, load_map, write_bam, write_map


def _workspace():
    from state.browser_state import BrowserState
    return BrowserState(None, None, None, None)


def _n_reads(state, chrom, dataset_id):
    return len(state.get_reads(chrom, 0, L, False, dataset_id))


def _compact(state, dataset_id, chrom):
    from services.read_route_helpers import build_direct_bam_reads
    dataset = state.datasets[dataset_id]
    return build_direct_bam_reads(state, dataset.path, chrom, 0, L, spanning_only=False)


def _coverage_max(state, chrom, dataset_id):
    from services.read_auxiliary_endpoint import get_coverage_payload
    return get_coverage_payload(state, chrom=chrom, start=0, end=L, bins=10, dataset_id=dataset_id)["max"]


def test_a_link_in_one_workspace_does_not_leak_into_another(tmp_path):
    from services.dataset_contigs import datasets_with_contig

    seq = _seq(201)
    a = _workspace()
    map_path = write_map(tmp_path / "aliasMap.gb", "aliasMap", seq)
    load_map(a, map_path)
    good = a.add_dataset("good", write_bam(tmp_path / "good.bam", "genericAlias", seq, m5=True, md=False))
    assert good.plasmid_report["links"][0]["chrom"] == "aliasMap"
    assert _n_reads(a, "aliasMap", "good") > 0

    b = _workspace()
    load_map(b, map_path)
    ds = b.add_dataset("unrelated", write_bam(tmp_path / "unrelated.bam", "genericAlias", _seq(202), m5=True, md=False))

    assert not ds.plasmid_report.get("links")
    assert datasets_with_contig(b, "aliasMap") == []
    assert _n_reads(b, "aliasMap", "unrelated") == 0
    assert _compact(b, "unrelated", "aliasMap") == []
    assert _coverage_max(b, "aliasMap", "unrelated") == 0
    # Workspace A still sees its own link.
    assert datasets_with_contig(a, "aliasMap") == ["good"]
    assert len(_compact(a, "good", "aliasMap")) > 0


def test_same_contig_name_in_two_frames_resolves_per_dataset(tmp_path):
    from services.dataset_contigs import datasets_with_contig

    seq = _seq(203)
    state = _workspace()
    load_map(state, write_map(tmp_path / "frameMap.gb", "frameMap", seq))
    a = state.add_dataset("frameA", write_bam(tmp_path / "a.bam", "sameContig", seq, m5=True))
    b = state.add_dataset("frameB", write_bam(tmp_path / "b.bam", "sameContig", _rot(seq, 700)))
    assert a.plasmid_report["links"][0]["chrom"] == "frameMap"
    link_b = b.plasmid_report["links"][0]
    assert (link_b["chrom"], link_b["offset"]) == ("sameContig", 700)

    assert datasets_with_contig(state, "frameMap") == ["frameA"]
    assert _n_reads(state, "frameMap", "frameA") > 0
    assert _n_reads(state, "frameMap", "frameB") == 0
    assert _compact(state, "frameB", "frameMap") == []
    assert _coverage_max(state, "frameMap", "frameB") == 0
    assert len(_compact(state, "frameB", "sameContig")) > 0


def test_a_contig_named_like_the_map_but_in_another_frame_stays_on_its_copy(tmp_path):
    from services.dataset_contigs import datasets_with_contig

    seq = _seq(210)
    state = _workspace()
    load_map(state, write_map(tmp_path / "pSame.gb", "pSame", seq))
    state.add_dataset("origin", write_bam(tmp_path / "origin.bam", "pSame", seq, m5=True))
    rotated = state.add_dataset("rotated", write_bam(tmp_path / "rotated.bam", "pSame", _rot(seq, 450)))
    link = rotated.plasmid_report["links"][0]
    assert link["offset"] == 450 and link["chrom"] != "pSame"

    # Its contig is called pSame, but its reads are in another frame: only the copy shows them.
    assert _n_reads(state, "pSame", "rotated") == 0
    assert _compact(state, "rotated", "pSame") == []
    assert len(_compact(state, "rotated", link["chrom"])) > 0
    assert datasets_with_contig(state, "pSame") == ["origin"]
    assert datasets_with_contig(state, link["chrom"]) == ["rotated"]


def test_unloading_or_replacing_a_dataset_drops_its_links(tmp_path):
    from services.plasmid_reconcile import contig_links

    seq = _seq(211)
    state = _workspace()
    load_map(state, write_map(tmp_path / "pGone.gb", "pGone", seq))
    state.add_dataset("reads", write_bam(tmp_path / "linked.bam", "linkedContig", seq, m5=True, md=False))
    assert contig_links(state, dataset_id="reads") == {"linkedContig": "pGone"}

    state.remove_dataset("reads")
    assert contig_links(state, dataset_id="reads") == {}

    # The same id, now other files: the old link does not apply to them.
    other = write_bam(tmp_path / "other.bam", "linkedContig", _seq(212), md=False)
    state.add_dataset("reads", other)
    assert contig_links(state, dataset_id="reads") == {}
    assert _n_reads(state, "pGone", "reads") == 0


@pytest.mark.parametrize("module", ["utils.chrom"])
def test_no_process_wide_alias_registry(module):
    import importlib
    chrom = importlib.import_module(module)
    for name in ("register_contig_alias", "contig_aliases", "_CONTIG_ALIASES"):
        assert not hasattr(chrom, name), name
