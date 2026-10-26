"""FiberHMM's st tag is in the stored-SEQ frame (reference C>T vs G>A on the stored SEQ), so exact
calls never complement it for a reverse-mapped record (agy review probe, 26 Oct)."""
from types import SimpleNamespace

from insertion_fixtures import SITE
from live_lift_fixtures import make_record, write_bam
from services.differences.alleles import DafContext, stored_frame_chemistry
from services.differences.workspace import inspect

INSERT = "ACGT" * 25                       # 25 C bases
CONVERTED = INSERT.replace("C", "T")       # every C deaminated, as stored in a CT read's SEQ


def test_st_tag_chemistry_is_stored_frame():
    assert stored_frame_chemistry(DafContext("CT", "BAM:st")) and stored_frame_chemistry(DafContext("CT", "bam_st_tag"))
    assert not stored_frame_chemistry(DafContext("CT", "synthetic")) and not stored_frame_chemistry(None)


def test_reverse_mapped_ct_read_with_converted_insert_carries_the_exact_allele(tmp_path):
    flank = "A" * 100
    reads = lambda h: [make_record(h, f"{strand}{i}", "chrT", SITE - 100, "100M100I100M", seq=flank + CONVERTED + flank,
                                   reverse=strand == "r", tags=[("st", "CT")]) for strand in "fr" for i in range(2)]
    path = write_bam(tmp_path / "daf.bam", reads, contigs=(("chrT", 30000),))
    ds = SimpleNamespace(id="native", data_type="bam", paths=[path])
    state = SimpleNamespace(datasets={ds.id: ds}, get_dataset=lambda _: ds, translate_chrom=lambda c: c, fasta=None)
    target = {"target_id": "exact-insert", "revision": 1, "target_type": "exact", "chrom": "chrT", "ref_start": SITE,
              "ref_end": SITE, "alt_bp": 100, "candidates": {"exact-insert": INSERT, "reference": ""}, "competition_complete": True}
    out = inspect(state, ds, chrom="chrT", start=SITE - 200, end=SITE + 200, target=target)["targets"][0]
    calls = {m.split("|")[-1] if "|" in m else m: c["call"] for m, c in out["calls_by_molecule"].items()}
    # Forward and reverse records alike: the C>T conversions are deamination, not noise.
    assert sorted(c["assignment"] for c in calls.values()) == ["target"] * 4, calls
