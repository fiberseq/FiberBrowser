"""Sequence search hits depend on the sequence only (3.1.1 deferred MED): reloading the annotation on the same
genome left the hits marked stale (the reference id was Identify's, which includes the annotation)."""
from __future__ import annotations

import time

from services import sequence_search as ss


class _State:
    def __init__(self, fasta):
        self.fasta_path = fasta
        self.current_genome = "toygenome"
        self.fasta = None
        self.plasmid_sequences = {}
        self.primer_blast_db = None
        self.primer_fasta = None
        self.gtf_data = None
        self.gtf_path = None
        self.orthogonal_tracks = []


def _fasta(path, seq):
    path.write_text(">chr1\n" + seq + "\n")
    import pysam
    pysam.faidx(str(path))
    return str(path)


def _wait(job_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        job = ss.get_search_job(job_id)
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.05)
    raise AssertionError("search did not finish")


def test_an_annotation_reload_on_the_same_genome_keeps_the_hits(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_BLAST_DB_DIR", str(tmp_path / "blastdb"))
    state = _State(_fasta(tmp_path / "toy.fa", "ACGT" * 50 + "GATTACAGGCTTCAAGT" + "TTGCA" * 40))
    started = ss.search_request(state, sequence="GATTACAGGCTTCAAGT", settings={"mode": "exact"})
    assert _wait(started["job_id"])["status"] == "done"
    before = ss.SearchReference(state).reference_id

    gtf = tmp_path / "genes.gtf"
    gtf.write_text('chr1\tx\texon\t1\t50\t.\t+\t.\tgene_id "G"; transcript_id "T";\n')
    state.gtf_data, state.gtf_path = {"transcripts": [{"id": "T"}]}, str(gtf)     # an annotation (re)load
    assert ss.SearchReference(state).reference_id == before
    gtf.write_text(gtf.read_text() + 'chr1\tx\texon\t60\t90\t.\t+\t.\tgene_id "H"; transcript_id "U";\n')
    state.gtf_data = {"transcripts": [{"id": "T"}, {"id": "U"}]}                 # edited and reloaded
    assert ss.SearchReference(state).reference_id == before
    added = ss.add_hits_track(state, started["job_id"])
    assert added["success"], added

    # Another FASTA still marks them stale.
    state.fasta_path = _fasta(tmp_path / "other.fa", "ACGT" * 80)
    assert ss.SearchReference(state).reference_id != before


def test_a_real_annotation_load_keeps_the_hits(tmp_path, monkeypatch):
    """The same through /api/load_gtf on a real BrowserState (genome identity and all)."""
    import asyncio
    from routers.tracks import load_gtf_endpoint
    from services import insertion_identify as ii
    from state.browser_state import BrowserState
    monkeypatch.setenv("FIBERBROWSER_BLAST_DB_DIR", str(tmp_path / "blastdb"))
    state = BrowserState(None, None, None, None)
    assert state._load_fasta(_fasta(tmp_path / "toy.fa", "ACGT" * 50 + "GATTACAGGCTTCAAGT" + "TTGCA" * 40)) is None
    started = ss.search_request(state, sequence="GATTACAGGCTTCAAGT", settings={"mode": "exact"})
    assert _wait(started["job_id"])["status"] == "done"
    before, before_identify = ss.SearchReference(state).reference_id, ii.reference_id(state)
    for genes in ("G", "H"):                                   # a load, then a reload of an edited file
        gtf = tmp_path / f"genes_{genes}.gtf"
        gtf.write_text(f'chr1\tx\ttranscript\t1\t50\t.\t+\t.\tgene_id "{genes}"; transcript_id "t{genes}";\n')
        assert asyncio.run(load_gtf_endpoint(path=str(gtf), state=state))["success"]
        assert ss.SearchReference(state).reference_id == before
    assert ii.reference_id(state) != before_identify           # Identify's id (which the hits had) moved
    assert ss.add_hits_track(state, started["job_id"])["success"]
