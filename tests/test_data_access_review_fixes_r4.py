"""Backend data-access fixes from the module review, round 4 (B1)."""
import sys
from types import SimpleNamespace

import pandas as pd


# --- 1. the folder picker's prompt is data, not AppleScript --------------------------

def test_folder_prompt_goes_to_osascript_as_an_argument(monkeypatch):
    from services import file_picker
    seen = {}

    def fake_run(script, args=()):
        seen["script"], seen["args"] = script, args
        return SimpleNamespace(returncode=0, stdout="/picked/\n", stderr="")

    monkeypatch.setattr(file_picker, "_run_mac_dialog", fake_run)
    monkeypatch.setattr(sys, "platform", "darwin")
    evil = '\\" & (do shell script "touch /tmp/pwned") & \\"'
    result = file_picker.pick_folder_payload(evil)
    assert result == {"success": True, "path": "/picked/"}
    assert "do shell script" not in seen["script"]
    assert seen["args"] == (evil,)
    assert "item 1 of argv" in seen["script"]


# --- 2. another assembly drops annotations loaded against the old one ------------------

def _fasta(path, records):
    import pysam
    path.write_text("".join(f">{name}\n{seq}\n" for name, seq in records))
    pysam.faidx(str(path))
    return str(path)


def _state():
    from state.browser_state import BrowserState
    return BrowserState(None, None, None, None)


def test_same_contig_names_of_another_assembly_drop_the_old_gtf(tmp_path):
    state = _state()
    state._load_fasta(_fasta(tmp_path / "old.fa", [("chr1", "A" * 100)]))
    state.gtf_data = {"transcripts": pd.DataFrame([{"chrom": "chr1", "start": 0, "end": 10}])}
    state.gtf_path = "/g/old.gtf"

    state._load_fasta(_fasta(tmp_path / "new.fa", [("chr1", "A" * 150)]))

    assert state.gtf_data is None and state.gtf_path is None


def test_a_gtf_loaded_with_no_reference_is_kept_when_it_fits(tmp_path):
    state = _state()
    gtf = {"transcripts": pd.DataFrame([{"chrom": "chr1", "start": 0, "end": 10}])}
    state.gtf_data = gtf
    state._load_fasta(_fasta(tmp_path / "a.fa", [("chr1", "A" * 100)]))
    assert state.gtf_data is gtf


def test_the_new_assemblys_cached_gtf_loads_after_the_old_one_goes(tmp_path, monkeypatch):
    import services.gene_annotations as annotations
    from state import browser_state
    genomes = tmp_path / "home" / ".fiberhmm" / "genomes"
    genomes.mkdir(parents=True)
    (genomes / "hg38.gtf").write_text("")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setitem(browser_state.GENOME_REGISTRY, "hg38", browser_state.GENOME_REGISTRY.get("hg38", {}))
    new_gtf = {"transcripts": pd.DataFrame([{"chrom": "chr1", "start": 5, "end": 50}])}
    monkeypatch.setattr(annotations, "load_gtf", lambda path: new_gtf)

    state = _state()
    state._load_fasta(_fasta(tmp_path / "hg19.fa", [("chr1", "A" * 100)]))
    state.gtf_data = {"transcripts": pd.DataFrame([{"chrom": "chr1", "start": 0, "end": 10}])}
    state.gtf_path = "/g/hg19.gtf"

    state._load_fasta(_fasta(tmp_path / "hg38.fa", [("chr1", "A" * 150)]))

    assert state.gtf_data is new_gtf
    assert state.gtf_path == str(genomes / "hg38.gtf")


# --- 3. BED12+ footprint BigBeds parse --------------------------------------------------

def test_bed12_plus_extra_columns_parse():
    from services.bigbed_read_loader import load_reads_from_bigbed

    class Handle:
        def chroms(self):
            return {"chr1": 1000}

        def entries(self, chrom, start, end):
            # name, score, strand, thickStart, thickEnd, rgb, count, sizes, starts, + blockNq
            rest = "r1\t0\t+\t100\t400\t0\t3\t1,20,1,\t0,50,299,\t0,30,0,"
            return [(100, 400, rest)]

    df = load_reads_from_bigbed(
        ["/x/a.bb"], "chr1", 0, 1000, spanning_only=False,
        bigbed_handle_getter=lambda path: Handle(),
        swapped_column_detector=lambda df: False,
        format_cache={},
    )
    assert not df.empty


# --- 4. the direct compact path honours cluster focus -----------------------------------

def test_direct_compact_reads_keep_only_the_focused_cluster(monkeypatch):
    from services.read_endpoint import compact_reads_payload_for_request
    dataset = SimpleNamespace(label="S", color="#000", data_type="bam", paths=[],
                              available_layers={"footprint": True},
                              cluster_assignments={"a": 0, "b": 1})

    class State:
        datasets = {"ds": dataset}
        dataset_order = ["ds"]
        _methylation_cache = {}

        def translate_chrom(self, chrom):
            return chrom

        def get_dataset(self, dataset_id):
            return self.datasets.get(dataset_id)

    monkeypatch.setattr("services.read_endpoint.load_direct_reads_for_dataset",
                        lambda *a, **k: [{"id": "a", "intervals": [[5, 25, 20]]},
                                         {"id": "b", "intervals": [[30, 60, 30]]}])
    payload = compact_reads_payload_for_request(
        State(), chrom="chr1", start=0, end=100, dataset_id="ds",
        include_cigar=True, cluster_focus="0", include_metaprofile=True,
    )
    assert [read["id"] for read in payload["reads"]] == ["a"]
    assert payload["working_count"] == 1
