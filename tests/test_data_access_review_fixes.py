"""Backend data-access fixes from the module review (B1)."""
import threading
from types import SimpleNamespace

import pytest

from models.requests import MergeDatasetsRequest


# --- chromosome names -----------------------------------------------------------

def test_reference_name_resolves_aliases_against_the_files_own_names():
    from utils.chrom import resolve_reference_name
    # The session map follows the FASTA (chr1 -> chr1); the BAM says "1".
    assert resolve_reference_name("chr1", ("1", "2"), {"chr1": "chr1", "1": "chr1"}) == "1"
    assert resolve_reference_name("chr1", ("1", "2")) == "1"
    assert resolve_reference_name("chrM", ("MT",)) == "MT"
    assert resolve_reference_name("chr1", ("chr1",)) == "chr1"
    assert resolve_reference_name("chr9", ("1", "2"), {"chr9": "chr9"}) is None


def test_bam_boundaries_fetch_through_an_alias(monkeypatch):
    import pysam
    from services import bam_boundaries

    fetched = []

    class Read:
        is_unmapped = is_secondary = is_supplementary = False
        reference_start, reference_end = 10, 20

    class Bam:
        references = ("1",)

        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def fetch(self, chrom, start, end):
            fetched.append(chrom)
            return [Read()]

    monkeypatch.setattr(pysam, "AlignmentFile", Bam)
    monkeypatch.setattr(bam_boundaries.os.path, "exists", lambda _p: True)
    bam_boundaries.get_read_boundaries_from_bam("x.bam", "chr1", 0, 100, chrom_map={"chr1": "chr1"})
    assert fetched == ["1"]


# --- genome switching -----------------------------------------------------------

class _Handle:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def _genome_state(fasta_result):
    old = _Handle()
    state = SimpleNamespace(current_genome="hg38", fasta=old, fasta_path="/g/hg38.fa",
                            gtf_data={"transcripts": ["human"]}, gtf_path="/g/hg38.gtf")

    def load_fasta(path, **kwargs):
        if fasta_result is None:
            state.fasta = _Handle()
            state.fasta_path = path
        return fasta_result

    state._load_fasta = load_fasta
    return state, old


def test_failed_fasta_does_not_leave_the_previous_genomes_sequence(tmp_path, monkeypatch):
    from services.genome_loading import load_genome_blocking
    monkeypatch.setenv("HOME", str(tmp_path))
    genomes = tmp_path / ".fiberhmm" / "genomes"
    genomes.mkdir(parents=True)
    (genomes / "mm10.gtf").write_text(
        'chr1\tsrc\ttranscript\t10\t50\t.\t+\t.\tgene_id "g"; transcript_id "t"; gene_name "Mouse";\n')
    state, old = _genome_state("Failed to download remote FASTA")

    result = load_genome_blocking(state, "mm10", {"name": "Mouse", "fasta_url": "https://x/mm10.fa",
                                                  "gtf_url": "https://x/mm10.gtf"})

    assert result["fasta_loaded"] is False and result["gtf_loaded"] is True
    assert state.current_genome == "mm10"
    assert state.fasta is None and old.closed  # no human sequence under mouse genes


def test_failed_gtf_does_not_leave_the_previous_genomes_annotations(tmp_path, monkeypatch):
    from services.genome_loading import load_genome_blocking
    monkeypatch.setenv("HOME", str(tmp_path))
    state, _old = _genome_state(None)

    result = load_genome_blocking(state, "mm10", {"name": "Mouse", "fasta_url": "https://x/mm10.fa"})

    assert result["fasta_loaded"] is True
    assert state.current_genome == "mm10"
    assert state.gtf_data is None


# --- merging datasets -----------------------------------------------------------

class _MergeState:
    def __init__(self, fail_add=False):
        self.datasets, self.dataset_order, self.fail_add = {}, [], fail_add

    def add_dataset(self, dataset_id, path_arg, label=None):
        if self.fail_add and dataset_id not in ("a", "b"):
            raise ValueError("cannot open")
        paths = path_arg if isinstance(path_arg, list) else [path_arg]
        ds = SimpleNamespace(id=dataset_id, paths=paths, label=label, derived_layers={}, available_layers={},
                             to_dict=lambda: {"id": dataset_id, "path": path_arg})
        self.datasets[dataset_id] = ds
        self.dataset_order.append(dataset_id)
        return ds

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def remove_dataset(self, dataset_id):
        self.datasets.pop(dataset_id, None)
        if dataset_id in self.dataset_order:
            self.dataset_order.remove(dataset_id)


def test_merging_bams_attaches_derived_layers_instead_of_listing_them_as_reads(monkeypatch):
    import services.dataset_endpoint as endpoint
    attached = []
    monkeypatch.setattr(endpoint, "register_derived_layer_file",
                        lambda dataset, path: attached.append((dataset.id, path)))
    state = _MergeState()
    a = state.add_dataset("a", "/d/a.bam", "A")
    a.derived_layers = {"cls": {"bundle_path": "/d/a.fiberlayers.bb"}}
    state.add_dataset("b", "/d/b.bam", "B")

    result = endpoint.merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))

    assert result["success"]
    assert result["dataset"]["path"] == ["/d/a.bam", "/d/b.bam"]  # all BAM: stays a BAM dataset
    assert attached == [(result["dataset"]["id"], "/d/a.fiberlayers.bb")]


def test_a_failed_merge_keeps_the_original_datasets():
    import services.dataset_endpoint as endpoint
    state = _MergeState(fail_add=True)
    state.add_dataset("a", "/d/a.bam", "A")
    state.add_dataset("b", "/d/b.bam", "B")

    result = endpoint.merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))

    assert not result["success"]
    assert state.dataset_order == ["a", "b"]


# --- BigBed handles ---------------------------------------------------------------

def test_bigbed_handles_are_shared_across_threads(monkeypatch, tmp_path):
    from services import bigbed_handles
    from services.file_handles import HandleCache

    class Handle:
        def __init__(self, path):
            self.path, self.closed = path, False

        def close(self):
            self.closed = True

    opened = []
    def open_reader(path):
        result = Handle(path)
        opened.append(result)
        return result
    monkeypatch.setattr(bigbed_handles.pyBigWig, "open", open_reader)
    monkeypatch.setattr(bigbed_handles, "handles", HandleCache(max_entries=1))
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'one.bb').write_bytes(b'one')
    (tmp_path / 'two.bb').write_bytes(b'two')
    got = []
    thread = threading.Thread(target=lambda: got.append(bigbed_handles.get_bigbed_handle("one.bb")))
    thread.start(); thread.join()
    mine = bigbed_handles.get_bigbed_handle("one.bb")
    assert got[0] is mine and len(opened) == 1
    bigbed_handles.get_bigbed_handle("two.bb")
    assert opened[0].closed
    # An evicted proxy remains usable without retaining an open descriptor.
    assert mine.path == "one.bb"
    assert opened[1].closed
    bigbed_handles.close_all_bigbed_handles()
    assert all(handle.closed for handle in opened)


def test_bigbed_names_returns_an_error_when_the_file_cannot_open(monkeypatch):
    from services import bigbed_names
    monkeypatch.setattr(bigbed_names.pyBigWig, "open", lambda _url: None)
    assert bigbed_names.fetch_bigbed_names_sync("https://x/y.bb", 10)["success"] is False


# --- public sessions --------------------------------------------------------------

def test_circular_inference_never_changes_the_shared_reference_on_a_public_server(monkeypatch):
    from services import runtime
    from state.browser_state import BrowserState
    from models.domain import ChromInfo

    template = BrowserState(None, None, None, None)
    template.chroms = [ChromInfo(name="chrM", size=16_000)]
    session = BrowserState.fork_for_session(template)
    monkeypatch.setattr(runtime, "_public_mode", True)

    session.infer_circular_chroms_from_dataset(SimpleNamespace(id="d", has_circular_annotations=True))

    assert template.circular_chroms == {}


def test_session_drop_is_locked_and_reentrant():
    from state.session_manager import SessionManager
    manager = SessionManager(SimpleNamespace(), enabled=True)
    manager.sessions["s"] = SimpleNamespace()
    manager.last_access["s"] = 0.0
    done = threading.Event()

    def drop_while_holding_the_lock():
        with manager._lock:  # as get_or_create does when making room
            manager.drop("s")
        done.set()

    t = threading.Thread(target=drop_while_holding_the_lock, daemon=True)
    t.start()
    t.join(2)
    assert done.is_set() and "s" not in manager.sessions


# --- direct read loading ------------------------------------------------------------

def test_direct_loading_includes_companion_files(monkeypatch):
    import services.read_endpoint as endpoint
    loaded = []

    def fake_bigbed_reads(paths, chrom, start, end, **kwargs):
        loaded.append((list(paths) if isinstance(paths, list) else [paths], kwargs))
        return [{"id": "r1", "intervals": [[0, 50, 20]], "layers": {}}]

    monkeypatch.setattr(endpoint, "build_direct_bigbed_reads", fake_bigbed_reads)
    dataset = SimpleNamespace(id="bb", data_type="bigbed", paths=["/d/a_footprint.bb", "/d/a_tf.bb"],
                              companion_layers={"tf": ["/d/a_tf.bb"]}, derived_layers={}, layer_type="footprint")
    state = SimpleNamespace(circular_chroms={}, chroms=[])

    endpoint.load_direct_reads_for_dataset(
        state, dataset, chrom="chr1", start=0, end=100, spanning_only=False, include_methylation=False,
        ml_threshold=125, min_fp_quality=0, include_cigar=False, hide_terminal_gaps=False,
        terminal_gap_threshold=500, include_layers=True, requested_layers=None, include_layer_qualities=True,
        infer_legacy_layers=True, legacy_nuc_min_size=90,
    )

    paths, kwargs = loaded[0]
    assert "/d/a_tf.bb" in paths
    assert kwargs["hide_terminal_gaps"] is False


def test_direct_loading_applies_quality_gates():
    from services.read_endpoint import apply_quality_filters_to_reads
    read = {"id": "r", "intervals": [[0, 10, 5]], "layers": {"tf": {
        "intervals": [[0, 10, 5], [20, 30, 5]], "quality_names": ["tq"], "qualities": [[10, 250]]}}}
    out = apply_quality_filters_to_reads([read], [{"layer": "tf", "quality_name": "tq", "min_value": 200}])
    assert [iv[:2] for iv in out[0]["layers"]["tf"]["intervals"]] == [[20, 30]]


def test_a_non_default_mark_threshold_takes_the_direct_path():
    from services.read_endpoint import needs_direct_read_load
    ds = SimpleNamespace(data_type="bam")
    assert not needs_direct_read_load(ds, include_methylation=True, ml_threshold=125)
    assert needs_direct_read_load(ds, include_methylation=True, ml_threshold=250)
    assert not needs_direct_read_load(ds, include_methylation=False, ml_threshold=250)


# --- coverage, compile, projection ----------------------------------------------------

def test_coverage_counts_each_molecule_once_across_companion_files():
    from services.read_coverage import compute_binned_read_coverage

    class BigBed:
        def chroms(self):
            return {"chr1": 1000}

        def entries(self, chrom, start, end):
            return [(0, 10, "read-a")]

    ds = SimpleNamespace(id="bb", data_type="bigbed", paths=["/d/a_footprint.bb", "/d/a_tf.bb", "/d/a_msp.bb"],
                         companion_layers={"tf": ["/d/a_tf.bb"], "msp": ["/d/a_msp.bb"]})
    result = compute_binned_read_coverage([ds], "chr1", 0, 100, 10, bam_handle_getter=lambda _p: None,
                                          bigbed_handle_getter=lambda _p: BigBed())
    assert result["coverage"][0] == 1


def test_compiled_regions_that_are_scaled_are_not_also_shifted():
    from services.read_compile import compile_reads_from_regions

    class State:
        datasets = {"ds": SimpleNamespace(available_layers={})}

        def translate_chrom(self, chrom):
            return chrom

        def build_working_set(self, *args, **kwargs):
            return SimpleNamespace(reads=[{"id": "r", "intervals": [[0, 100, 20]], "methyl": [90]}])

    result = compile_reads_from_regions(State(), [SimpleNamespace(chrom="c", start=0, end=100, label=None)],
                                        dataset_ids=["ds"], spanning=False, max_reads_per_region=10,
                                        anchor="center", target_width=200)
    read = result["reads"][0]
    assert read["intervals"] == [[0, 200, 20]]
    assert read["methyl"] == [180]


def test_projected_marks_stay_inside_the_half_open_region():
    from services.working_sets import _project_deam_events, _project_positions
    assert _project_positions([0, 99, 100], 0, 100) == [0, 99]
    assert _project_deam_events([[0, 1], [100, 0]], 0, 100) == [[0, 1]]
