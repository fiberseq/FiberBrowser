"""Primer design review fixes: the configured FASTA, bounded DAF-C quad search, GTF coordinates."""
import itertools
from types import SimpleNamespace

import numpy as np
import pytest


def test_primer_reference_uses_the_configured_fasta_not_the_browsers(tmp_path):
    import pysam
    from services.primer_reference import get_fasta_interface
    a, b = tmp_path / "a.fa", tmp_path / "b.fa"
    a.write_text(">chr1\nAAAAAAAAAA\n")
    b.write_text(">chr1\nCCCCCCCCCC\n")
    pysam.faidx(str(a))
    pysam.faidx(str(b))
    state = SimpleNamespace(fasta=pysam.FastaFile(str(a)), fasta_path=str(a))
    fetch, _length, _names = get_fasta_interface(state, str(b))
    assert fetch("chr1", 0, 4) == "CCCC"
    fetch, _length, _names = get_fasta_interface(state, str(a))
    assert fetch("chr1", 0, 4) == "AAAA"


def test_tm_compatible_quads_matches_the_dense_search_in_row_major_order():
    from services.primer_dafc_endpoint import tm_compatible_quads
    rng = np.random.default_rng(1)
    x = rng.uniform(55, 65, size=(37, 2))
    y = rng.uniform(55, 65, size=(23, 2))
    dense = np.concatenate([np.broadcast_to(x[:, None, :], (37, 23, 2)),
                            np.broadcast_to(y[None, :, :], (37, 23, 2))], axis=2)
    want = np.where(dense.max(axis=2) - dense.min(axis=2) <= 2.0)
    got = tm_compatible_quads(x, y, 2.0, max_cells=50)  # several blocks
    assert list(zip(*got)) == list(zip(*want))
    capped = tm_compatible_quads(x, y, 2.0, limit=5, max_cells=50)
    assert list(zip(*capped)) == list(itertools.islice(zip(*want), 5))


def test_primer_designer_gtf_is_zero_based_like_the_browser(tmp_path):
    from primer_designer import load_gtf
    gtf = tmp_path / "g.gtf"
    gtf.write_text(
        '2L\tsrc\tgene\t101\t200\t.\t+\t.\tgene_id "p"; gene_name "plus";\n'
        '2L\tsrc\tgene\t301\t400\t.\t-\t.\tgene_id "m"; gene_name "minus";\n'
    )
    df = load_gtf(str(gtf)).set_index('gene_name')
    assert (df.loc['plus', 'start'], df.loc['plus', 'end'], df.loc['plus', 'TSS']) == (100, 200, 100)
    assert (df.loc['minus', 'start'], df.loc['minus', 'end'], df.loc['minus', 'TSS']) == (300, 400, 399)


def test_an_n_in_the_reference_skips_those_candidates_instead_of_aborting():
    pytest.importorskip("primer3")  # optional Primer-panel package
    from services.primer_candidates import fast_find_primers
    seq = "ACCTACCATCCTACTCCTAC" + "N" + "ACCTACCATCCTACTCCTAC"
    df = fast_find_primers(seq, 0, 18, 20, 40, 80, max_gs=5, max_run_length=0, max_gc_pct=100,
                           check_tandem_repeats=False)
    assert len(df) > 0 and not df["sequences"].str.contains("N").any()


def test_standalone_designer_handles_n_prefixed_gtf_and_blast_failure(tmp_path, monkeypatch):
    pytest.importorskip("primer3")  # optional Primer-panel package
    import os
    import subprocess
    import pandas as pd
    import primer_designer as pd_mod
    starts, primers, _tms = pd_mod.find_filter_primers("ACCTACCATCCTACTCCTACN", 20, 0, 0, 100, 5, False)
    assert all("N" not in p for p in primers)

    gtf = tmp_path / "g.gtf"
    gtf.write_text('chr1\tsrc\tgene\t101\t200\t.\t+\t.\tgene_id "p"; gene_name "plus";\n')
    assert list(pd_mod.load_gtf(str(gtf))["chrom"]) == ["chr1"]  # not chrchr1

    made = []
    real_ntf = pd_mod.tempfile.NamedTemporaryFile

    def tracking_ntf(*args, **kwargs):
        f = real_ntf(*args, **kwargs)
        made.append(f.name)
        return f

    monkeypatch.setattr(pd_mod.tempfile, "NamedTemporaryFile", tracking_ntf)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=2))
    pairs = pd.DataFrame({"fwd_sequences": ["ACGTACGTACGTACGTACGT"], "rev_sequences": ["TTTTACGTACGTACGTACGT"]})
    out = pd_mod.blast_primers(pairs, "/nonexistent/db")
    assert out.empty
    assert made and not any(os.path.exists(p) for p in made)  # temp files cleaned up


def test_a_new_primer_run_keeps_tracking_another_runs_blast():
    import services.primer_blast_runtime as rt

    class Proc:
        killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

    import contextvars

    running = Proc()
    with rt._process_lock:
        rt._processes.append(running)

    def another_tab():
        rt.reset_primer_blast_runtime()  # another tab starts a run
        rt.request_primer_design_abort()

    try:
        # In its own context, as each request's run is: the aborted run's
        # token must not stay with the test thread.
        contextvars.copy_context().run(another_tab)
        assert running.killed
    finally:
        with rt._process_lock:
            if running in rt._processes:
                rt._processes.remove(running)


def test_tm_compatible_quads_bounds_memory_for_huge_candidate_sets():
    from services.primer_dafc_endpoint import tm_compatible_quads
    x = np.full((50_000, 2), 60.0)
    y = np.full((50_000, 2), 60.0)
    i, j = tm_compatible_quads(x, y, 1.0)  # the dense search would need 80 GB
    assert len(i) == len(j) == 20_000
