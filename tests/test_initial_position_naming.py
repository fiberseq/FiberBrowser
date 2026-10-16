"""The empty start locus uses the loaded FASTA's chromosome names (usability round 3, R15).

With no BAM open, the start locus is a random TSS from the GTF. An Ensembl GTF says '2L' where the FASTA (and the
chromosome menu) say 'chr2L': the locus box showed '2L:16,600,821-16,610,821' beside a menu reading 'chr2L'.
"""
from __future__ import annotations

from types import SimpleNamespace

import pandas as pd

from state.browser_state import BrowserState


def _state(chroms, gtf_chrom, chrom_map=None):
    tx = pd.DataFrame([{"chrom": gtf_chrom, "start": 16_605_821, "end": 16_610_000, "strand": "+", "gene_name": "g"}])
    return SimpleNamespace(
        _initial_data_position=lambda ids: None,
        gtf_data={"transcripts": tx},
        chroms=[SimpleNamespace(name=n, size=30_000_000) for n in chroms],
        chrom_map=chrom_map or {},
    )


def test_start_locus_takes_the_fasta_naming():
    pos = BrowserState.get_initial_position(_state(["chr2L", "chr3R"], "2L"))
    assert pos["chrom"] == "chr2L"
    assert (pos["start"], pos["end"]) == (16_600_821, 16_610_821)


def test_a_bam_chrom_map_still_wins_and_matching_names_stay():
    assert BrowserState.get_initial_position(_state(["chr2L"], "2L", {"2L": "2L"}))["chrom"] == "2L"
    assert BrowserState.get_initial_position(_state(["2L"], "2L"))["chrom"] == "2L"
