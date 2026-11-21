"""Find classes and molecules shared by two datasets (one sequencing run assigned to both samples).

FiberHMM's class engines count each physical molecule once and refuse a run that
holds one molecule in two datasets. Find classes refuses legibly before the load,
or, when the BAMs declare shared provenance with deduplication on, analyses each
shared molecule once. Other loaders keep both copies, as before."""
import pysam
import pytest

from models.domain import Dataset
from state.browser_state import BrowserState
from services import consensus_workflow as cw

SHARED = [f"movieA/{i}/ccs" for i in range(3)]


def _bam(path, names, supplementary=()):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"},
                                               "SQ": [{"SN": "chrT", "LN": 5000}]})
    rows = []
    for name in names:
        for flag in ((0, 2048) if name in supplementary else (0,)):
            read = pysam.AlignedSegment(header)
            read.query_name, read.reference_id, read.flag = name, 0, flag
            read.reference_start = 1000 if flag == 0 else 1300
            read.mapping_quality, read.cigarstring, read.query_sequence = 60, "200M", "A" * 200
            rows.append(read)
    rows.sort(key=lambda r: r.reference_start)
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in rows:
            out.write(read)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def two_bams(tmp_path):
    first = _bam(tmp_path / "early.bam", SHARED + ["movieA/7/ccs", "movieA/8/ccs"])
    # The second sample holds the same three molecules (one with a supplementary piece) and two of its own.
    second = _bam(tmp_path / "late.bam", SHARED + ["movieB/0/ccs", "movieB/1/ccs"], supplementary={SHARED[1]})
    return first, second


def _state(first, second, groups=("", ""), policies=("off", "off")):
    state = BrowserState(None)
    for dsid, path, group, policy in zip(("early", "late"), (first, second), groups, policies):
        ds = Dataset(dsid, path, dsid + " sample", data_type="bam")
        ds.molecule_groups = [[path, group]] if group else []
        ds.joint_dedup = policy
        state.datasets[dsid] = ds
        state.dataset_order.append(dsid)
    return state


REQUEST = dict(dataset_ids=["early", "late"], chrom="chrT", start=900, end=1600,
               chemistry_overrides={"early": "hia5-pacbio", "late": "hia5-pacbio"})


@pytest.fixture
def recording_loader(monkeypatch):
    """FiberHMM's BAM loader replaced by one that records the reads each dataset's inputs hold."""
    seen = {}
    def loader(datasets, region, options, progress):
        for item in datasets:
            with pysam.AlignmentFile(item["paths"][0]) as bam:
                seen[item["dataset_id"]] = sorted((r.query_name, r.is_supplementary) for r in bam.fetch())
        return dict(strata=[dict(dataset_id=d["dataset_id"], units=[]) for d in datasets],
                    input_files=[dict(dataset_id=d["dataset_id"], path=d["paths"][0]) for d in datasets])
    import fiberhmm.inference.consensus.bam as fh_bam
    monkeypatch.setattr(fh_bam, "load_bam_payload", loader)
    return seen


def test_find_classes_refuses_undeclared_shared_molecules_before_loading(two_bams, recording_loader):
    state = _state(*two_bams)
    with pytest.raises(ValueError, match="same molecules are in more than one dataset") as raised:
        cw.load_payload(state, dict(REQUEST, _one_view_per_molecule=True), None, None)
    message = str(raised.value)
    assert "3 molecules in early sample and late sample" in message
    assert "Deduplicate shared molecules" in message
    assert "movieA" not in message and "/ccs" not in message
    assert recording_loader == {}  # refused before the evidence load


def test_deduplication_needs_a_shared_group_and_every_holder_opted_in(two_bams, recording_loader):
    first, second = two_bams
    for groups, policies in ((("g", "g"), ("by_molecule", "off")), (("g", "h"), ("by_molecule", "by_molecule")),
                             (("g", ""), ("by_molecule", "by_molecule"))):
        with pytest.raises(ValueError, match="same molecules"):
            cw.load_payload(_state(first, second, groups, policies), dict(REQUEST, _one_view_per_molecule=True), None, None)


def test_declared_deduplication_analyses_each_shared_molecule_once(two_bams, recording_loader):
    first, second = two_bams
    state = _state(first, second, ("embryo", "embryo"), ("by_molecule", "by_molecule"))
    payload = cw.load_payload(state, dict(REQUEST, _one_view_per_molecule=True), None, None)
    early = {name for name, _ in recording_loader["early"]}
    late = {name for name, _ in recording_loader["late"]}
    assert set(SHARED) <= early and len(early) == 5  # kept in the first dataset by ID
    assert late == {"movieB/0/ccs", "movieB/1/ccs"}  # the supplementary piece leaves with its molecule
    assert payload["browser_warnings"] == ["3 molecules in more than one dataset analysed once (deduplicated by "
                                           "molecule: 3 shared by early sample and late sample, kept in early sample)."]
    assert [f["path"] for f in payload["input_files"]] == [first, second]  # provenance names the user's files


def test_other_loaders_keep_both_copies(two_bams, recording_loader):
    payload = cw.load_payload(_state(*two_bams), dict(REQUEST), None, None)
    assert {n for n, _ in recording_loader["late"]} >= set(SHARED)
    assert not payload.get("browser_warnings")


def test_molecules_are_matched_by_movie_and_zmw_and_distinct_ones_load_unchanged(tmp_path, recording_loader):
    first = _bam(tmp_path / "a.bam", ["movieA/1/ccs", "movieA/2/ccs"])
    # FiberHMM's PacBio key is movie/ZMW: another read of ZMW 2 is the same molecule.
    second = _bam(tmp_path / "b.bam", ["movieB/1/ccs", "movieA/2/fwd"])
    with pytest.raises(ValueError, match="1 molecule in"):
        cw.load_payload(_state(first, second), dict(REQUEST, _one_view_per_molecule=True), None, None)
    third = _bam(tmp_path / "c.bam", ["movieB/1/ccs", "movieB/2/ccs"])
    payload = cw.load_payload(_state(first, third), dict(REQUEST, _one_view_per_molecule=True), None, None)
    assert not payload.get("browser_warnings") and recording_loader["late"] == [("movieB/1/ccs", False), ("movieB/2/ccs", False)]


def test_submit_asks_the_loader_for_one_view_per_molecule(two_bams, monkeypatch):
    state = _state(*two_bams)
    sent = {}
    def load(state, request, options, progress):
        sent.update(request)
        raise ValueError("stop at the loader")
    monkeypatch.setattr(cw, "load_payload", load)
    monkeypatch.setattr(cw, "_summary", lambda j: j)
    job = cw.submit(state, dict(REQUEST, parameters=dict(cr=dict(engine="lattice_recaller"))))
    job["_future"].result(timeout=30)
    assert sent.get("_one_view_per_molecule") is True
    assert job["status"] == "error" and job["message"] == "stop at the loader"
    assert "_one_view_per_molecule" not in job["request"]  # the saved request is unchanged


def test_a_shared_molecule_is_kept_where_its_copy_loads(tmp_path):
    """Declared sharing: the keeper is the first dataset (by ID) whose copy the class load keeps; a dataset holding
    only a supplementary piece (never loaded) does not take the molecule from one holding its primary."""
    from services.consensus_molecules import resolve_shared_molecules
    name = "movieC/5/ccs"
    early = _bam(tmp_path / "e.bam", [name], supplementary={name})
    # drop the early primary: early holds only the supplementary piece
    with pysam.AlignmentFile(early) as bam:
        rows = [r for r in bam.fetch() if r.is_supplementary]
        header = bam.header
    with pysam.AlignmentFile(early, "wb", header=header) as out:
        for r in rows:
            out.write(r)
    pysam.index(early)
    late = _bam(tmp_path / "l.bam", [name])
    state = _state(early, late, groups=("run1", "run1"), policies=("by_molecule", "by_molecule"))
    datasets = [dict(dataset_id="early", paths=[early]), dict(dataset_id="late", paths=[late])]
    removed, warning = resolve_shared_molecules(state, datasets, dict(chrom="chrT", start=900, end=1600))
    assert removed == {"early": {name}} and "kept in late sample" in warning
