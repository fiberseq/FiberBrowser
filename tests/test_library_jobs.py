"""Finished New DAF-seq runs join the Library; Re-call builds a pipeline job."""
from __future__ import annotations

import os
import sys

import pytest

from library_fixtures import (DDDB_DECLARATION, legacy_pipeline_settings, make_fiberhmm_bam, make_job, make_pipeline_run,
                              pipeline_settings, seq)
from services import library_inspect as inspect
from services import library_jobs as jobs
from services import library_store as store


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    # A background recording queued by an earlier test must not land in this test's Library.
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    return tmp_path


def test_finished_runs_are_imported_once(tmp_path):
    genome_run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1")
    plasmid_run = make_pipeline_run(tmp_path / "runs" / "P1", sample="P1", plasmid_seq=seq(11))
    make_job(tmp_path / "jobs", "20260929-101010-aaaaaa", tmp_path / "runs" / "S1", sample="S1")
    make_job(tmp_path / "jobs", "20260929-111111-bbbbbb", tmp_path / "runs" / "P1", sample="P1")
    make_job(tmp_path / "jobs", "20260929-121212-cccccc", tmp_path / "runs" / "X", status="running")
    make_job(tmp_path / "jobs", "not-a-job-id", tmp_path / "runs" / "S1")

    assert jobs.import_finished_jobs() == {"imported": 3, "available": True}
    entries = {os.path.basename(e["path"]): e for e in store.load()["entries"].values()}
    assert set(entries) == {"S1.fiberhmm.bam", "P1.fiberhmm.bam", "pTest.gb"}
    s1 = entries["S1.fiberhmm.bam"]
    assert s1["job"]["id"] == "20260929-101010-aaaaaa" and s1["job"]["group"] == "g1"
    assert s1["sources"] == ["job:20260929-101010-aaaaaa"] and s1["date_source"] == "run finished"
    assert s1["qc"]["verdicts"]["overall"] == "PASS" and s1["chemistry"]["key"] == "dddb"
    assert entries["P1.fiberhmm.bam"]["pipeline"]["plasmid_map"] == plasmid_run["plasmid_map"]
    assert genome_run["called_bam"] == s1["path"]

    # Imported once: a removed entry stays removed.
    store.remove_entries([s1["id"]])
    assert jobs.import_finished_jobs()["imported"] == 0
    assert len(store.load()["entries"]) == 2


def test_no_registry_is_fine(tmp_path):
    assert jobs.import_finished_jobs() == {"imported": 0, "available": True}


def _entry(path, **extra):
    info = inspect.inspect_file(path)
    info.update(extra)
    entry_id = store.record(info)["id"]
    return store.load()["entries"][entry_id]


def test_recall_plan_for_a_pipeline_run(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    entry = _entry(run["called_bam"])
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "out"))
    assert plan["tool"] == "fiberhmm-pipeline"
    assert plan["reads"] == [run["aligned_bam"]]  # from the aligned BAM, not the called one
    assert plan["reference"]["path"] == run["plasmid_map"] and plan["reference"]["kind"] == "plasmid_map"
    assert plan["enzyme"] == "dddb" and plan["outdir"] == str(tmp_path / "out")


def test_recall_refuses_non_daf_and_unknown_reference(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    hia5 = make_fiberhmm_bam(tmp_path / "h.bam", comments=[
        "FIBERHMM-CHEMISTRY:v1:assay=fiber-seq;enzyme=hia5;platform=pacbio;mode=pacbio-fiber"])
    with pytest.raises(jobs.RecallError, match="DddA and DddB"):
        jobs.plan_recall(_entry(hia5), outdir=str(tmp_path / "o"))
    # A fiberhmm-pipeline re-call (recorded settings) needs the reference the reads were aligned to.
    # (Without recorded settings the header's fiberhmm-call command is re-run, which needs none.)
    lone = make_fiberhmm_bam(tmp_path / "lone.bam", contigs=(("contig_1", 5000),))
    with pytest.raises(jobs.RecallError, match="reference"):
        jobs.plan_recall(_entry(lone, pipeline={"settings": pipeline_settings("dddb")}), outdir=str(tmp_path / "o"))


def test_an_advisory_the_pipeline_cannot_fix_refuses_the_recall(tmp_path, monkeypatch):
    # This test used to require a fiberhmm-recall-tfs plan for any advisory whose
    # prose mentioned "recall-tfs" -- the incomplete remedy review round 4 found.
    # An advisory FiberBrowser has no complete automatic remedy for is refused,
    # with FiberHMM's own fix.
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    entry = _entry(run["called_bam"], advisories={"key": "x", "items": [
        {"id": "tf-table", "severity": "rerun-recommended", "title": "TF table",
         "fix": "fiberhmm-recall-tfs with the current table"}]})
    with pytest.raises(jobs.RecallError, match="TF table: fiberhmm-recall-tfs with the current table"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "o"))


def test_the_real_tag_m5c_advisory_is_not_planned_as_recall_tfs(tmp_path, monkeypatch):
    # Review round 4 repro: FiberHMM's tag-m5c-missing-ucg advisory needs
    # fiberhmm-tag-m5c first, then recall-tfs --use-m5c; recall-tfs alone was planned.
    pytest.importorskip("fiberhmm.advisories")
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    bam = make_fiberhmm_bam(tmp_path / "old_tag.bam", comments=[DDDB_DECLARATION.replace("dddb", "ddda")], programs=[
        {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0", "CL": "fiberhmm-call --enzyme ddda"},
        {"ID": "fiberhmm-tag-m5c", "PN": "fiberhmm-tag-m5c", "VN": "2.16.7", "CL": "fiberhmm-tag-m5c -i calls.bam"}])
    entry = _entry(bam)
    ids = [a["id"] for a in entry["advisories"]["items"] if a["severity"].startswith("rerun")]
    assert ids == ["tag-m5c-missing-ucg"]
    with pytest.raises(jobs.RecallError, match="fiberhmm-tag-m5c") as refused:
        jobs.plan_recall(entry, outdir=str(tmp_path / "o"))
    assert "Re-run fiberhmm-tag-m5c with FiberHMM >= 3.0, then fiberhmm-call again on the tagged BAM" in str(refused.value)


def test_the_most_complete_remedy_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    items = [{"id": "dddb-gt-table", "severity": "rerun-required", "artifact": "calls"},
             {"id": "daf-dedup-orientation", "severity": "rerun-recommended", "artifact": "dedup flags"},
             {"id": "primary-only-default", "severity": "info", "artifact": "calls"}]
    entry = _entry(run["called_bam"], advisories={"key": "x", "items": items})
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "o"))
    assert plan["tool"] == "fiberhmm-pipeline" and plan["reads"] == [run["aligned_bam"]]
    assert plan["advisories_fixed"] == ["dddb-gt-table", "daf-dedup-orientation"]
    # The duplicate-flag fix needs the un-deduplicated aligned reads, not the called BAM.
    os.remove(run["aligned_bam"])
    with pytest.raises(jobs.RecallError, match="un-deduplicated"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "o"))
    # Calls alone: the called BAM (the aligned reads plus old tags) is an acceptable input.
    entry["advisories"]["items"] = items[:1]
    assert jobs.plan_recall(entry, outdir=str(tmp_path / "o"))["reads"] == [run["called_bam"]]


def test_submit_recall_queues_a_job(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    entry = _entry(run["called_bam"])
    created = {}
    from services import pipeline_jobs

    class FakeManager:
        root = str(tmp_path / "jobs")

        def create(self, spec, admit=None):
            created.update(spec)
            return {"id": spec["id"], "status": "queued"}

    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: FakeManager())
    job = jobs.submit_recall(entry, outdir=str(tmp_path / "recall"))
    assert job["status"] == "queued"
    assert created["argv"][:2] == [sys.executable, "-c"]
    assert "--reference" in created["argv"] and run["aligned_bam"] in created["argv"]
    assert created["library_recall"]["entry_id"] == entry["id"]
    assert created["option_labels"][0].startswith("re-call with FiberHMM")


# --- Review round 4: a re-call keeps the original run's calling settings ------

class _FakeManager:
    def __init__(self, root):
        self.root = str(root)
        self.created = {}

    def create(self, spec, admit=None):
        self.created.update(spec)
        return {"id": spec["id"], "status": "queued"}


def _run_with_settings(tmp_path, **changed):
    import json
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    outputs = os.path.join(os.path.dirname(run["called_bam"]), "outputs.json")
    raw = json.loads(open(outputs).read())
    raw["settings"] = pipeline_settings("dddb", **changed)
    with open(outputs, "w") as handle:
        json.dump(raw, handle)
    return run


REVIEW_SETTINGS = {"dedup": "off", "snp_screen": "off", "prob_threshold": 200, "alignments": "all",
                   "primary_only": False, "chimera_filter": False, "min_mapq": 40}


def test_recall_carries_the_original_calling_settings(tmp_path, monkeypatch):
    # Review round 4 repro: these settings were recorded, and the submitted job had
    # options={} and none of their flags.
    from services import pipeline_jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    run = _run_with_settings(tmp_path, **REVIEW_SETTINGS)
    entry = _entry(run["called_bam"])
    manager = _FakeManager(tmp_path / "jobs")
    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: manager)
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"))
    assert plan["settings"]["source"] == "outputs.json"
    for flag in ("--dedup off", "--snp-screen off", "--prob-threshold 200", "--alignments all",
                 "--no-chimera-filter", "--min-mapq 40"):
        assert flag in plan["display_command"], flag
    jobs.submit_recall(entry, outdir=str(tmp_path / "recall"), plan_id=plan["plan_id"])
    created = manager.created
    assert created["options"]["dedup"] == "off" and created["options"]["prob_threshold"] == 200
    assert created["options"]["alignments"] == "all" and created["options"]["chimera_filter"] is False
    argv = " ".join(created["argv"])
    for flag in ("--dedup off", "--snp-screen off", "--prob-threshold 200", "--alignments all",
                 "--no-chimera-filter", "--min-mapq 40"):
        assert flag in argv, flag
    assert "MAPQ 40" in created["option_labels"] and "ML threshold 200" in created["option_labels"]


def test_recalled_settings_round_trip_through_the_real_pipeline_parser(tmp_path, monkeypatch):
    """What the re-call passes makes fiberhmm-pipeline record the same settings again."""
    parser_module = pytest.importorskip("fiberhmm.cli.pipeline")
    mask = tmp_path / "snps.bed"
    mask.write_text("p\t1\t2\n")
    recorded = pipeline_settings("dddb", **REVIEW_SETTINGS, snp_mask=str(mask), min_read_length=500,
                                 dedup_mode="collapse", hard_clip="off", origin_merge=False, tracks=True,
                                 qc=False, call_args=["--with-scores", "--min-llr", "6"])
    recorded["dedup"] = "on"
    run = _run_with_settings(tmp_path, **{k: v for k, v in recorded.items() if k != "enzyme"})
    entry = _entry(run["called_bam"])
    from services import pipeline_inputs as pi
    command = pi.pipeline_command()  # the real FiberHMM this FiberBrowser uses
    if command.get("source") != "fiberhmm":
        pytest.skip("fiberhmm.cli.pipeline is not importable for --help")
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"))
    args = pi.pipeline_args(reads=plan["reads"], reference=plan["reference"]["path"], enzyme=plan["enzyme"],
                            outdir=plan["outdir"], sample=plan["sample"], cores=plan["cores"], progress="p.jsonl",
                            regions=plan["regions"], extra=plan["extra"])
    config = parser_module.config_from_args(parser_module.parse_args(args))
    assert config.calling_settings() == recorded


def _recalled_settings(tmp_path, plan, parser_module):
    from services import pipeline_inputs as pi
    args = pi.pipeline_args(reads=plan["reads"], reference=plan["reference"]["path"], enzyme=plan["enzyme"],
                            outdir=plan["outdir"], sample=plan["sample"], cores=plan["cores"], progress="p.jsonl",
                            regions=plan["regions"], extra=plan["extra"])
    return parser_module.config_from_args(parser_module.parse_args(args)).calling_settings()


def _real_pipeline():
    parser_module = pytest.importorskip("fiberhmm.cli.pipeline")
    from services import pipeline_inputs as pi
    if pi.pipeline_command().get("source") != "fiberhmm":
        pytest.skip("fiberhmm.cli.pipeline is not importable for --help")
    return parser_module


@pytest.mark.parametrize("changed", [
    # FiberHMM 3.0 run settings: the alignment set, hard_clip as on/off/circular, the DAF unaligned mask
    # (the pipeline's option, or fiberhmm-call's in --call-args) and the insert consensus (off in --call-args).
    dict(alignments="primary", primary_only=True, hard_clip="on", daf_unaligned_mask=False,
         daf_insert_consensus=None),
    dict(alignments="all", hard_clip="off", call_args=["--daf-insert-consensus", "off"],
         daf_insert_consensus="off"),
    dict(call_args=["--no-daf-mask-unaligned"], daf_unaligned_mask=False, daf_insert_consensus=None),
    dict(),
    # A basecaller override (--basecaller-info / --modbase-model) is given again, as recorded.
    dict(basecaller_override={"program": "dorado", "version": "0.9.6",
                              "basecall_model": "dna_r10.4.1_e8.2_400bps_sup@v5.0.0", "modbase_models": []}),
    dict(basecaller_override={"modbase_models": ["dna_r10.4.1_e8.2_400bps_sup@v5.0.0_6mA@v2"]}),
])
def test_fiberhmm_3_run_settings_round_trip_through_the_real_pipeline_parser(tmp_path, monkeypatch, changed):
    parser_module = _real_pipeline()
    recorded = pipeline_settings("dddb", **changed)
    run = _run_with_settings(tmp_path, **{k: v for k, v in recorded.items() if k != "enzyme"})
    plan = jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "recall"))
    assert plan["settings"]["changed_defaults"] == [] and plan["settings"]["rewrites"] == []
    assert _recalled_settings(tmp_path, plan, parser_module) == recorded
    if changed.get("call_args") == ["--no-daf-mask-unaligned"]:
        assert "--no-daf-mask-unaligned" not in plan["extra"]  # carried in --call-args, not doubled


def test_a_run_from_before_the_3_0_defaults_lists_them_and_keeps_the_original_on_request(tmp_path, monkeypatch):
    """outputs.json written before supplementary calling (primary_only true, boolean hard_clip, no
    unaligned mask): the re-call gets 3.0's defaults, each listed with the flag that keeps the original."""
    parser_module = _real_pipeline()
    import json
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    outputs = os.path.join(os.path.dirname(run["called_bam"]), "outputs.json")
    raw = json.loads(open(outputs).read())
    raw["settings"] = legacy_pipeline_settings("dddb")
    with open(outputs, "w") as handle:
        json.dump(raw, handle)
    entry = _entry(run["called_bam"])
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"))
    changes = {c["id"]: c for c in plan["settings"]["changed_defaults"]}
    assert list(changes) == ["alignments", "soft_clips", "daf_unaligned_mask"]
    assert "supplementary alignments" in changes["alignments"]["text"]
    assert "soft clips on linear contigs" in changes["soft_clips"]["text"]
    assert "inserted and soft-clipped bases" in changes["daf_unaligned_mask"]["text"]
    assert [changes[c]["restore"] for c in changes] == [["--alignments", "primary"], ["--hard-clip"],
                                                         ["--no-daf-mask-unaligned"]]
    assert not any(c["kept_old"] for c in changes.values())
    new = _recalled_settings(tmp_path, plan, parser_module)
    assert new["alignments"] == "primary-supplementary" and new["hard_clip"] == "circular"
    assert new["daf_unaligned_mask"] is True
    kept = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"),
                            keep_old=["alignments", "soft_clips", "daf_unaligned_mask"])
    assert kept["plan_id"] != plan["plan_id"] and all(c["kept_old"] for c in kept["settings"]["changed_defaults"])
    old = _recalled_settings(tmp_path, kept, parser_module)
    assert old["alignments"] == "primary" and old["primary_only"] is True and old["hard_clip"] == "on"
    assert old["daf_unaligned_mask"] is False
    with pytest.raises(jobs.RecallError, match="no original behaviour to keep for tf_decoder"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), keep_old=["tf_decoder"])
    # A non-default recorded before 3.0 is carried as it was: primary_only false (every alignment),
    # hard_clip false (soft clips kept).
    raw["settings"] = legacy_pipeline_settings("dddb", primary_only=False, hard_clip=False)
    with open(outputs, "w") as handle:
        json.dump(raw, handle)
    plan = jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "recall"))
    assert [c["id"] for c in plan["settings"]["changed_defaults"]] == ["daf_unaligned_mask"]
    new = _recalled_settings(tmp_path, plan, parser_module)
    assert new["alignments"] == "all" and new["hard_clip"] == "off"


def test_retired_options_in_the_recorded_call_args_are_dropped_and_listed(tmp_path, monkeypatch):
    parser_module = _real_pipeline()
    run = _run_with_settings(tmp_path, call_args=["--phase-nrl", "auto", "--min-llr", "6",
                                                  "--nuc-recall-policy=topology"])
    plan = jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "recall"))
    assert plan["settings"]["rewrites"] == [
        {"flag": "--call-args --phase-nrl", "from": "auto", "to": None,
         "why": "retired in FiberHMM 3.0: caused artifacts"},
        {"flag": "--call-args --nuc-recall-policy", "from": "topology", "to": None,
         "why": "retired in FiberHMM 3.0: caused artifacts"}]
    assert _recalled_settings(tmp_path, plan, parser_module)["call_args"] == ["--min-llr", "6"]


def test_contradictory_or_unknown_3_0_settings_are_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -m fiberhmm.cli.pipeline")
    for changed, why in ((dict(alignments="primary", primary_only=False), "contradict"),
                         (dict(alignments="secondary"), "alignments='secondary'"),
                         (dict(hard_clip="sometimes"), "hard_clip='sometimes'"),
                         (dict(daf_insert_consensus="maybe"), "daf_insert_consensus='maybe'")):
        run = _run_with_settings(tmp_path, **changed)
        with pytest.raises(jobs.RecallError, match=why):
            jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "o"))


def test_a_run_record_from_before_the_3_0_defaults_lists_them(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -m fiberhmm.cli.pipeline")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    folder = make_job(tmp_path / "jobs", "20260929-101010-bbbbbb", tmp_path / "runs" / "S1")
    spec_path = os.path.join(folder, "spec.json")
    spec = json.loads(open(spec_path).read())
    spec.update(options={"dedup": "on", "primary_only": True})
    with open(spec_path, "w") as handle:
        json.dump(spec, handle)
    jobs.import_finished_jobs()
    entry = next(e for e in store.load()["entries"].values() if e["path"] == run["called_bam"])
    outputs = os.path.join(os.path.dirname(run["called_bam"]), "outputs.json")
    raw = json.loads(open(outputs).read())
    raw.pop("settings")
    with open(outputs, "w") as handle:
        json.dump(raw, handle)
    entry = _entry(run["called_bam"], job=entry["job"])
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "o"))
    assert plan["settings"]["source"] == "run record"
    assert [c["id"] for c in plan["settings"]["changed_defaults"]] == ["alignments", "soft_clips", "daf_unaligned_mask"]
    assert "--alignments" not in plan["extra"]
    kept = jobs.plan_recall(entry, outdir=str(tmp_path / "o"), keep_old=["alignments"])
    assert kept["extra"][-2:] == ["--alignments", "primary"] or "--alignments primary" in kept["display_command"]


def test_recall_carries_the_run_record_regions_and_options(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "fiberhmm-pipeline")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    folder = make_job(tmp_path / "jobs", "20260929-101010-aaaaaa", tmp_path / "runs" / "S1")
    spec_path = os.path.join(folder, "spec.json")
    spec = json.loads(open(spec_path).read())
    spec.update(regions=["pTest:100-900"], options={"dedup": "on", "use_m5c": "auto"})
    with open(spec_path, "w") as handle:
        json.dump(spec, handle)
    jobs.import_finished_jobs()
    entry = next(e for e in store.load()["entries"].values() if e["path"] == run["called_bam"])
    assert entry["job"]["regions"] == ["pTest:100-900"]
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "o"))
    assert plan["regions"] == ["pTest:100-900"] and plan["settings"]["regions_recorded"] is True
    assert "--region pTest:100-900" in plan["display_command"]
    # Without outputs.json settings, the run record's wizard options are used.
    outputs = os.path.join(os.path.dirname(run["called_bam"]), "outputs.json")
    raw = json.loads(open(outputs).read())
    raw.pop("settings")
    with open(outputs, "w") as handle:
        json.dump(raw, handle)
    entry = _entry(run["called_bam"], job=entry["job"])
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "o"))
    assert plan["settings"]["source"] == "run record" and "--dedup on" in plan["display_command"]


def test_recall_refuses_when_the_settings_cannot_be_recovered(tmp_path, monkeypatch):
    # Until FiberBrowser 3.0 a BAM without outputs.json or a run record was refused with "re-call it
    # yourself"; its header's command is now re-run (tests/test_recall_header.py). What stays refused:
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -m fiberhmm.cli.pipeline")
    pytest.importorskip("fiberhmm.cli.call")
    # a header command whose input is relative to a folder it does not record: the user is asked for it
    genome = make_fiberhmm_bam(tmp_path / "lone.bam", contigs=(("pTest", 3000),), programs=[
        {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0",
         "CL": "fiberhmm-call -i a.bam -o b.bam --enzyme dddb --no-primary"}])
    with pytest.raises(jobs.RecallError, match="relative to a folder") as refused:
        jobs.plan_recall(_entry(genome), outdir=str(tmp_path / "o"))
    assert refused.value.needs_input == {"flag": "-i", "recorded": "a.bam", "reason": "relative"}
    # no FiberHMM command in the header at all: the way forward inside the app, not a terminal
    bare = make_fiberhmm_bam(tmp_path / "bare.bam", contigs=(("pTest", 3000),), programs=[])
    with pytest.raises(jobs.RecallError, match="cannot tell which calling options") as refused:
        jobs.plan_recall(_entry(bare), outdir=str(tmp_path / "o"))
    assert "New DAF-seq run" in str(refused.value) and refused.value.start_new_run
    assert "yourself" not in str(refused.value) and "terminal" not in str(refused.value)
    run = _run_with_settings(tmp_path, future_knob=3)
    with pytest.raises(jobs.RecallError, match="future_knob"):
        jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "o"))
    run = _run_with_settings(tmp_path, snp_mask=str(tmp_path / "gone.bed"))
    with pytest.raises(jobs.RecallError, match="SNP mask not found"):
        jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "o"))


def test_submit_runs_only_the_reviewed_plan(tmp_path, monkeypatch):
    import json
    from services import pipeline_jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    run = _run_with_settings(tmp_path)
    entry = _entry(run["called_bam"])
    reviewed = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"))
    manager = _FakeManager(tmp_path / "jobs")
    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: manager)
    # The run's settings changed after the plan was shown.
    changed = _run_with_settings(tmp_path, min_mapq=5)
    entry = _entry(changed["called_bam"])
    with pytest.raises(jobs.RecallError, match="plan changed"):
        jobs.submit_recall(entry, outdir=str(tmp_path / "recall"), plan_id=reviewed["plan_id"])
    assert manager.created == {}
    with pytest.raises(jobs.RecallError, match="plan changed"):
        jobs.submit_recall(entry, outdir=str(tmp_path / "elsewhere"),
                           plan_id=jobs.plan_recall(entry, outdir=str(tmp_path / "recall"))["plan_id"])
    del json


def test_recall_respects_a_lab_servers_run_limits(tmp_path, monkeypatch):
    from services import pipeline_jobs
    from services.lab import jobs as lab_jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    run = _run_with_settings(tmp_path)
    entry = _entry(run["called_bam"])
    monkeypatch.setattr(lab_jobs, "max_cores", lambda: 2)
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=16)
    assert plan["cores"] == 2
    manager = _FakeManager(tmp_path / "jobs")
    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: manager)
    monkeypatch.setattr(lab_jobs, "check_submit", lambda n: "You have 1 run(s) queued or running (limit 1).")
    with pytest.raises(jobs.RecallError, match="queued or running"):
        jobs.submit_recall(entry, outdir=str(tmp_path / "recall"), cores=16, plan_id=plan["plan_id"])
    assert manager.created == {}


# --- Review round 8: a reviewed plan is bound to its inputs and to the FiberHMM that runs it ---

def _reviewed_recall(tmp_path, monkeypatch):
    from services import pipeline_jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    entry = _entry(run["called_bam"])
    manager = _FakeManager(tmp_path / "jobs")
    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: manager)
    options = {"outdir": str(tmp_path / "recall"), "cores": 1}
    return run, entry, manager, options, jobs.plan_recall(entry, **options)


def test_an_unchanged_reviewed_plan_starts(tmp_path, monkeypatch):
    _run, entry, manager, options, reviewed = _reviewed_recall(tmp_path, monkeypatch)
    assert jobs.plan_recall(entry, **options)["plan_id"] == reviewed["plan_id"]
    jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    assert manager.created


@pytest.mark.parametrize("change", ["input_bytes", "input_touched", "reference_bytes", "fiberhmm_command",
                                    "fiberhmm_version", "fiberhmm_package"])
def test_a_reviewed_plan_is_refused_after_its_inputs_or_fiberhmm_changed(tmp_path, monkeypatch, change):
    run, entry, manager, options, reviewed = _reviewed_recall(tmp_path, monkeypatch)
    if change == "input_bytes":
        with open(run["aligned_bam"], "ab") as handle:
            handle.write(b"changed")
    elif change == "input_touched":  # same bytes, rewritten later (e.g. replaced by another copy)
        st = os.stat(run["aligned_bam"])
        os.utime(run["aligned_bam"], ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    elif change == "reference_bytes":
        with open(reviewed["reference"]["path"], "a") as handle:
            handle.write("\n>changed\nACGT\n")
    elif change == "fiberhmm_command":
        monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -B -c pass")
    elif change == "fiberhmm_version":
        installed = inspect.current_fiberhmm_version()  # whatever is installed: always a different version
        monkeypatch.setattr(inspect, "current_fiberhmm_version", lambda: f"{installed}+changed")
    else:  # the same version string, but FiberHMM's installed files changed
        real = jobs._fiberhmm_identity
        monkeypatch.setattr(jobs, "_fiberhmm_identity", lambda *a: {**real(*a), "commit": "0" * 40})
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    assert manager.created == {}


def test_a_mask_named_in_the_arguments_is_part_of_the_plan(tmp_path, monkeypatch):
    mask = tmp_path / "mask.bed"
    mask.write_text("chr1\t0\t10\n")
    assert jobs._argument_files(["--snp-mask", str(mask), "--call-args", f"-m {mask} --x"]) == [str(mask), str(mask)]
    plan = {"reads": [], "reference": {}, "extra": ["--snp-mask", str(mask)]}
    before = [jobs._file_identity(p) for p in jobs._plan_inputs(plan)]
    mask.write_text("chr1\t0\t20\n")
    assert [jobs._file_identity(p) for p in jobs._plan_inputs(plan)] != before


def test_fiberhmm_identity_reads_the_checked_out_commit(tmp_path):
    git = tmp_path / "src" / ".git"
    (git / "refs" / "heads").mkdir(parents=True)
    (git / "HEAD").write_text("ref: refs/heads/main\n")
    (git / "refs" / "heads" / "main").write_text("a" * 40 + "\n")
    (tmp_path / "src" / "fiberhmm").mkdir()
    assert jobs._git_head(str(tmp_path / "src" / "fiberhmm")) == "a" * 40
    (git / "refs" / "heads" / "main").unlink()
    (git / "packed-refs").write_text("# pack-refs\n" + "b" * 40 + " refs/heads/main\n")
    assert jobs._git_head(str(tmp_path / "src")) == "b" * 40



# --- Review round 13: the plan binds the FiberHMM the job runs, resolved as the job resolves it ---

def _job_fiberhmm(root, version="3.0.0"):
    cli = root / "fiberhmm" / "cli"
    cli.mkdir(parents=True)
    (cli.parent / "__init__.py").write_text(f'__version__ = "{version}"\n')
    (cli / "__init__.py").write_text("")
    (cli / "pipeline.py").write_text('print("version A")\n')
    (root / "fiberhmm" / "models").mkdir()
    (root / "fiberhmm" / "models" / "table.json").write_text("{}")
    return root


def _plan_with_command(tmp_path, monkeypatch, command):
    from services import pipeline_inputs as pi, pipeline_jobs
    monkeypatch.setattr(pi, "pipeline_command", lambda: command)
    monkeypatch.setattr(pi, "pipeline_help", lambda *a: None)
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    entry = _entry(run["called_bam"])
    manager = _FakeManager(tmp_path / "jobs")
    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: manager)
    options = {"outdir": str(tmp_path / "recall"), "cores": 1}
    return entry, manager, options, jobs.plan_recall(entry, **options)


@pytest.mark.parametrize("change", ["pipeline_code", "bundled_table", "version"])
def test_the_plan_binds_the_fiberhmm_in_the_jobs_own_environment(tmp_path, monkeypatch, change):
    root = _job_fiberhmm(tmp_path / "job_fiberhmm", version="3.9.9")
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "source": "fiberhmm",
               "env": {"PYTHONPATH": str(root)}}
    entry, manager, options, reviewed = _plan_with_command(tmp_path, monkeypatch, command)
    runs = jobs._fiberhmm_identity(command)["runs"]
    assert runs["found"] and runs["location"] == os.path.realpath(root / "fiberhmm")
    assert runs["version"] == "3.9.9" and reviewed["version"] == "3.9.9"  # the job's, not the Browser's
    if change == "pipeline_code":  # same size, same version: only the content differs
        (root / "fiberhmm" / "cli" / "pipeline.py").write_text('print("version B")\n')
    elif change == "bundled_table":
        (root / "fiberhmm" / "models" / "table.json").write_text('{"x": 1}')
    else:
        (root / "fiberhmm" / "__init__.py").write_text('__version__ = "3.9.10"\n')
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    assert manager.created == {}


def test_the_browsers_own_fiberhmm_does_not_decide_a_jobs_identity(tmp_path, monkeypatch):
    root = _job_fiberhmm(tmp_path / "job_fiberhmm")
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "source": "fiberhmm",
               "env": {"PYTHONPATH": str(root)}}
    entry, manager, options, reviewed = _plan_with_command(tmp_path, monkeypatch, command)
    monkeypatch.setattr(inspect, "current_fiberhmm_version", lambda: "9.9.9")
    (root / "fiberhmm" / "cli" / "pipeline.py").touch()  # a touch without a change is no change
    jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    assert manager.created


def test_a_console_script_is_resolved_through_its_interpreter(tmp_path, monkeypatch):
    root = _job_fiberhmm(tmp_path / "job_fiberhmm", version="3.1.0")
    script = tmp_path / "bin" / "fiberhmm-pipeline"
    script.parent.mkdir()
    script.write_text(f"#!{sys.executable}\nimport sys\nfrom fiberhmm.cli.pipeline import main\nsys.exit(main())\n")
    script.chmod(0o755)
    command = {"argv": [str(script)], "source": "path", "env": {"PYTHONPATH": str(root)}}
    runs = jobs._fiberhmm_identity(command)["runs"]
    assert runs["found"] and runs["version"] == "3.1.0"


def test_a_linked_worktrees_commit_is_bound(tmp_path):
    main_git = tmp_path / "main" / ".git"
    admin = main_git / "worktrees" / "checkout"
    admin.mkdir(parents=True)
    (main_git / "refs" / "heads").mkdir(parents=True)
    (main_git / "refs" / "heads" / "release").write_text("c" * 40 + "\n")
    checkout = tmp_path / "checkout"
    (checkout / "fiberhmm").mkdir(parents=True)
    (checkout / ".git").write_text(f"gitdir: {admin}\n")
    (admin / "HEAD").write_text("a" * 40 + "\n")  # detached
    assert jobs._git_head(str(checkout / "fiberhmm")) == "a" * 40
    (admin / "HEAD").write_text("ref: refs/heads/release\n")
    (admin / "commondir").write_text("../..\n")
    assert jobs._git_head(str(checkout)) == "c" * 40


# --- Review round 17: the identity is resolved exactly as the job is launched, and nothing is created ---

def _printing_fiberhmm(root, version):
    package = root / "fiberhmm"
    (package / "cli").mkdir(parents=True)
    (package / "__init__.py").write_text(f'__version__ = "{version}"\n')
    (package / "cli" / "__init__.py").write_text("")
    (package / "cli" / "pipeline.py").write_text("from fiberhmm import __version__\nprint('RAN', __version__)\n")
    return package


def _launched_version(tmp_path, spec):
    """What the production launcher actually runs for a submitted spec."""
    from services import pipeline_jobs
    job_dir = tmp_path / "launched"
    job_dir.mkdir()
    process = pipeline_jobs.JobManager(str(tmp_path / "launcher_jobs"))._launch(spec, str(job_dir))
    assert process.wait(20) == 0
    return [line for line in (job_dir / "log").read_text().splitlines() if line.startswith("RAN")][-1].split()[1]


def test_a_not_yet_created_output_folder_is_the_jobs_working_folder(tmp_path, monkeypatch):
    # Round 17: with PYTHONPATH=.. the probe ran in the Browser's folder and bound another FiberHMM.
    parent = tmp_path / "execution"
    package = _printing_fiberhmm(parent, "3.0.A")
    outdir = parent / "new-output"
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "source": "environment",
               "env": {"PYTHONPATH": ".."}}
    entry, manager, _options, _ = _plan_with_command(tmp_path, monkeypatch, command)
    options = {"outdir": str(outdir), "cores": 1}
    reviewed = jobs.plan_recall(entry, **options)
    assert reviewed["version"] == "3.0.A" and not outdir.exists()  # resolved there, nothing created
    (package / "__init__.py").write_text('__version__ = "3.0.B"\n')
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    fresh = jobs.plan_recall(entry, **options)
    jobs.submit_recall(entry, plan_id=fresh["plan_id"], **options)
    assert fresh["version"] == "3.0.B" == _launched_version(tmp_path, manager.created)


def test_the_jobs_interpreter_options_are_kept(tmp_path, monkeypatch):
    # Round 17: "python -E -m ..." ignores PYTHONPATH, but the probe dropped -E and bound that package.
    import venv
    runtime = tmp_path / "venv"
    venv.EnvBuilder(with_pip=False, symlinks=True).create(runtime)
    site = runtime / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
    actual = _printing_fiberhmm(site, "3.0.A")
    _printing_fiberhmm(tmp_path / "misleading", "3.0.OTHER")
    command = {"argv": [str(runtime / "bin" / "python"), "-E", "-m", "fiberhmm.cli.pipeline"],
               "source": "environment", "env": {"PYTHONPATH": str(tmp_path / "misleading")}}
    entry, manager, options, reviewed = _plan_with_command(tmp_path, monkeypatch, command)
    assert reviewed["version"] == "3.0.A"
    (actual / "__init__.py").write_text('__version__ = "3.0.B"\n')
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    fresh = jobs.plan_recall(entry, **options)
    jobs.submit_recall(entry, plan_id=fresh["plan_id"], **options)
    assert _launched_version(tmp_path, manager.created) == fresh["version"] == "3.0.B"


def test_tables_beneath_a_symlinked_directory_are_part_of_the_identity(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    package = _printing_fiberhmm(root, "3.0.A")
    tables = tmp_path / "tables"
    (tables / "nested").mkdir(parents=True)
    model = tables / "nested" / "model.tsv"
    model.write_text("model A\n")
    (package / "data").symlink_to(tables, target_is_directory=True)
    (tables / "loop").symlink_to(package, target_is_directory=True)  # a cycle back into the package
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "env": {"PYTHONPATH": str(root)}}
    entry, manager, options, reviewed = _plan_with_command(tmp_path, monkeypatch, command)
    model.write_text("model B\n")
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)


def test_a_module_command_whose_package_cannot_be_found_is_refused(tmp_path, monkeypatch):
    from services import pipeline_inputs as pi
    command = {"argv": [sys.executable, "-I", "-m", "no_such_fiberhmm.cli.pipeline"], "env": {}}
    monkeypatch.setattr(pi, "pipeline_command", lambda: command)
    monkeypatch.setattr(pi, "pipeline_help", lambda *a: None)
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    with pytest.raises(jobs.RecallError, match="can't import no_such_fiberhmm"):
        jobs.plan_recall(_entry(run["called_bam"]), outdir=str(tmp_path / "out"), cores=1)


# --- Review round 18: symlinked working folders, the frozen app's -m role, retargeted links ---

def test_a_symlinked_working_folder_is_seen_as_the_job_sees_it(tmp_path, monkeypatch):
    physical, lexical = tmp_path / "physical", tmp_path / "lexical"
    actual = _printing_fiberhmm(physical, "3.0.A")
    (physical / "out").mkdir()
    _printing_fiberhmm(lexical, "3.0.OTHER")
    marker = tmp_path / "probe-only-startup"
    (lexical / "sitecustomize.py").write_text(f"open({str(marker)!r}, 'w').write('ran')\n")
    outdir = lexical / "out"
    outdir.symlink_to(physical / "out", target_is_directory=True)
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "env": {"PYTHONPATH": ".."}}
    entry, manager, _options, _ = _plan_with_command(tmp_path, monkeypatch, command)
    options = {"outdir": str(outdir), "cores": 1}
    reviewed = jobs.plan_recall(entry, **options)
    assert reviewed["version"] == "3.0.A" and not marker.exists()  # the job's package; no startup code it skips
    (actual / "__init__.py").write_text('__version__ = "3.0.B"\n')
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    fresh = jobs.plan_recall(entry, **options)
    jobs.submit_recall(entry, plan_id=fresh["plan_id"], **options)
    assert _launched_version(tmp_path, manager.created) == fresh["version"] == "3.0.B"


def test_a_new_folder_below_a_symlink_resolves_like_the_launch(tmp_path, monkeypatch):
    physical, lexical = tmp_path / "physical", tmp_path / "lexical"
    (physical / "base").mkdir(parents=True)
    _printing_fiberhmm(physical, "3.0.A")
    _printing_fiberhmm(lexical, "3.0.OTHER")
    (lexical / "base").symlink_to(physical / "base", target_is_directory=True)
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "env": {"PYTHONPATH": "../.."}}
    runs = jobs._fiberhmm_identity(command, str(lexical / "base" / "new-out"))["runs"]
    assert runs["version"] == "3.0.A" and not (physical / "base" / "new-out").exists()


def test_retargeting_a_link_between_folders_already_read_changes_the_identity(tmp_path):
    root = tmp_path / "runtime"
    package = _printing_fiberhmm(root, "3.0.A")
    for name in ("a", "b"):
        (package / name).mkdir()
        (package / name / "model.tsv").write_text(f"MODEL {name}")
    alias = package / "data"
    alias.symlink_to(package / "a", target_is_directory=True)
    command = {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "env": {"PYTHONPATH": str(root)}}
    before = jobs._fiberhmm_identity(command, str(tmp_path / "out"))
    alias.unlink()
    alias.symlink_to(package / "b", target_is_directory=True)
    assert jobs._fiberhmm_identity(command, str(tmp_path / "out")) != before


def test_the_frozen_apps_module_role_is_probed_with_its_own_import_path(tmp_path):
    """The Mac app's -m role puts its working folder first (frozen_entry.run); the probe
    runs the app's -c role, which must see the same path (here: a package in the output folder)."""
    import subprocess
    from pathlib import Path
    repo = Path(__file__).resolve().parents[1]
    bundled, out = tmp_path / "bundled", tmp_path / "output"
    _printing_fiberhmm(bundled, "3.0.BUNDLED")
    _printing_fiberhmm(out, "3.0.LOCAL")
    app = tmp_path / "app"
    app.write_text(f"#!{sys.executable}\nimport sys\n"
                   f"sys.path[:] = [{str(repo)!r}, {str(bundled)!r}] + [p for p in sys.path if p not in ('', {str(tmp_path)!r})]\n"
                   "sys.frozen = True\nfrom fiberbrowser import frozen_entry\nraise SystemExit(frozen_entry.run())\n")
    app.chmod(0o755)
    command = {"argv": [str(app), "-m", "fiberhmm.cli.pipeline"], "env": {}}
    runs = jobs._fiberhmm_identity(command, str(out))["runs"]
    ran = subprocess.run(command["argv"], cwd=out, capture_output=True, text=True, timeout=60)
    assert ran.returncode == 0 and ran.stdout.split()[-1] == runs["version"] == "3.0.LOCAL"
