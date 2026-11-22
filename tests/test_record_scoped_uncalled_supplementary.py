"""Record-scoped decoding (lift composition, graph decode) hides a supplementary with its uncalled primary
(3.1.1 deferred MED; services/supplementary_primary.py).

Record-scoped loading treated every supplementary as called, so an uncalled molecule came back through its
supplementary under "Hide reads without footprint calls". An earlier fix (a pre-scan of the fetch for uncalled
primaries) was reverted: its answer depended on which primaries a fetch or a graph cache happened to hold (N1),
one uncalled occurrence vetoed a molecule that also had a called primary (N2), and it ran outside the load budget
and cancellation (N3). The supplementary's primary is now looked up through its SA tag, so the answer depends only
on the file; these tests pin all three.
"""
from array import array

import pytest

from live_lift_fixtures import make_record, write_bam
from services.compact_read_loader import build_compact_reads_from_bam
from services.lift.live_lift import LoadBudget

CONTIG = "chrS"
CALLS = [("ns", array("I", [10])), ("nl", array("I", [60]))]


def _sa(pos, cigar="200M"):
    return ("SA", f"{CONTIG},{pos + 1},+,{cigar},60,0;")


def _bam(tmp_path, records):
    return write_bam(tmp_path / "s.bam", lambda h: [make_record(h, name, CONTIG, pos, cigar, flag=flag, tags=tags)
                                                     for name, pos, cigar, flag, tags in records],
                     contigs=((CONTIG, 20_000),))


def _rows(path, start=0, end=20_000, **options):
    return build_compact_reads_from_bam(path, CONTIG, start, end, spanning_only=False, include_supplementary=True,
                                        hide_uncalled=True, **options)


def _ids(path, start=0, end=20_000, **options):
    return sorted(row["id"] for row in _rows(path, start, end, **options))


@pytest.mark.parametrize("supp_pos", [500, 5000])   # before and after its primary in coordinate order
def test_supplementary_of_an_uncalled_primary_is_hidden(tmp_path, supp_pos):
    path = _bam(tmp_path, [
        ("called", 1000, "200M", 0, CALLS),
        ("called", 3000, "100M", 2048, CALLS + [_sa(1000)]),
        ("uncalled", 2000, "200M", 0, []),
        ("uncalled", supp_pos, "100M", 2048, [_sa(2000)]),
    ])
    assert _ids(path) == ["called", "called"]


def test_the_answer_does_not_depend_on_the_fetch_n1(tmp_path):
    """The supplementary alone in a narrow fetch, and with its uncalled primary in a wide one: hidden both times
    (graph decode fetches only the spans its cache lacks, so a fetch-dependent rule changed with history)."""
    path = _bam(tmp_path, [
        ("uncalled", 9000, "200M", 0, []),
        ("uncalled", 500, "100M", 2048, [_sa(9000)]),
        ("other", 600, "100M", 0, CALLS),
    ])
    assert _ids(path, start=0, end=2000) == ["other"]
    assert _ids(path) == ["other"]
    assert _ids(path, start=0, end=2000) == ["other"]


def test_a_called_primary_is_never_vetoed_by_an_uncalled_one_n2(tmp_path):
    path = _bam(tmp_path, [
        ("shared", 1000, "200M", 0, CALLS),
        ("shared", 2000, "200M", 0, []),
        ("shared", 5000, "100M", 2048, [("SA", f"{CONTIG},2001,+,200M,60,0;{CONTIG},1001,+,200M,60,0;")]),
    ])
    # The called primary and the supplementary stay (the uncalled primary itself is hidden, as always).
    assert _ids(path) == ["shared", "shared"]


def test_without_a_found_primary_the_supplementary_stays(tmp_path):
    path = _bam(tmp_path, [
        ("no_sa", 500, "100M", 2048, []),
        ("elsewhere", 700, "100M", 2048, [("SA", "chrMissing,100,+,200M,60,0;")]),
    ])
    assert _ids(path) == ["elsewhere", "no_sa"]


def test_qcfail_primary_shown_by_choice_keeps_its_supplementary(tmp_path):
    path = _bam(tmp_path, [
        ("chimera", 2000, "200M", 0x200, []),
        ("chimera", 500, "100M", 0x200 | 2048, [_sa(2000)]),
    ])
    assert _ids(path, include_qcfail=True) == ["chimera", "chimera"]
    assert _ids(path) == []


def test_uncalled_shown_keeps_every_record(tmp_path):
    path = _bam(tmp_path, [
        ("uncalled", 2000, "200M", 0, []),
        ("uncalled", 500, "100M", 2048, [_sa(2000)]),
    ])
    rows = build_compact_reads_from_bam(path, CONTIG, 0, 20_000, spanning_only=False, include_supplementary=True,
                                        hide_uncalled=False)
    assert len(rows) == 2


def test_lookups_are_bounded_and_report_truncation_n3(tmp_path):
    """The primary lookups have an allowance of their own (at most the load's record budget): a lookup deeper than
    it stops, keeps the supplementary and reports the lifted load truncated, without spending the view's budget."""
    records = [("uncalled", 9000, "200M", 0, []), ("uncalled", 100, "100M", 2048, [_sa(9000)])]
    records += [(f"deep{i}", 8990, "200M", 0, CALLS) for i in range(50)]
    path = _bam(tmp_path, records)
    budget = LoadBudget(max_records=20)
    assert _ids(path, start=0, end=1000, load_budget=budget) == ["uncalled"]
    assert budget.truncated
    assert budget.records == 1  # the view's own record only
    roomy = LoadBudget(max_records=1000)
    assert _ids(path, start=0, end=1000, load_budget=roomy) == []
    assert not roomy.truncated and roomy.records == 1
