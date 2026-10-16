"""Re-call from the FiberHMM command a BAM's header records (no outputs.json, no run record).

Two kinds of recorded command: a script-path fiberhmm-call with relative outputs and
--dedup (s01), and an unquoted WSL command with spaces in its paths, written on another
computer (amp_DddB).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import pysam
import pytest

from library_fixtures import DDDB_DECLARATION, make_bam, make_fiberhmm_bam
from services import library_inspect as inspect
from services import library_jobs as jobs
from services import library_store as store
from services import recall_header as rh

call_module = pytest.importorskip("fiberhmm.cli.call")

S01_CL = ("/Users/someone/src/FiberHMM/fiberhmm/cli/call.py -i {input} -o calls/s01.fixed.dddb.bam "
          "--enzyme dddb --seq nanopore --mode daf --primary --min-mapq 20 --min-read-length 500 "
          "--prob-threshold 128 --dedup -c 4 --io-threads 2 --no-qc --region-parallel --chroms chr2L "
          "--daf-snp-output-prefix snp/s01")
S01_DS = ("FiberHMM fused apply+recall; coord=molecular; mode=daf enzyme=dddb tf_decoder=multi_interval_v1 "
          "tf_interval_penalty=5.0 recall_nucs=True dedup=j0.95/mark/ends50 daf_snp_mask=on/22sites")
AMP_CL = ("/home/someone/env/bin/fiberhmm-call -i {root}/input/amp_dddb_bulk_2-4h.raw.bam "
          "-o {root}/calls/amp_dddb.full.bam --enzyme dddb -c 8 --io-threads 4 --no-qc --region-parallel "
          "--chroms chr3L --daf-snp-output-prefix {root}/snp/amp_dddb.full")
AMP_DS = "FiberHMM fused apply+recall; coord=molecular; mode=daf enzyme=dddb recall_nucs=True dedup=j0.95/mark/ends50"
DEDUP = {"id": "daf-dedup-orientation", "severity": "rerun-recommended", "title": "DAF duplicates grouped by "
         "alignment orientation", "fix": "Re-run fiberhmm-dedup (or fiberhmm-call --dedup) on the un-deduplicated "
         "input with FiberHMM >= 3.0, then re-run what was made from it"}
GT = {"id": "dddb-gt-table", "severity": "rerun-required", "title": "DddB calls made with an older model",
      "fix": "Re-call with FiberHMM >= 3.0"}
CALL = f"{sys.executable} -m fiberhmm.cli.call"


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_CALL_COMMAND", CALL)
    monkeypatch.setenv("FIBERBROWSER_NO_CAFFEINATE", "1")
    return tmp_path


_TABLE: dict = {}


def call_table() -> rh.Table:
    """The current fiberhmm-call's option table, read by the production probe."""
    if "call" not in _TABLE:
        proc = subprocess.run([sys.executable, "-c", rh.PARSER_PROBE, "fiberhmm.cli.call", "", "table"],
                              capture_output=True, text=True, timeout=120)
        _TABLE["call"] = rh.Table("fiberhmm-call", json.loads(proc.stdout.strip().splitlines()[-1]))
    return _TABLE["call"]


def build(cl, tmp_path, **kwargs):
    kwargs.setdefault("entry_path", str(tmp_path / "entry.bam"))
    kwargs.setdefault("enzyme", "dddb")
    kwargs.setdefault("platform", "nanopore")
    kwargs.setdefault("outdir", str(tmp_path / "out"))
    kwargs.setdefault("cores", 2)
    kwargs.setdefault("ds", "tf_decoder=multi_interval_v1 primary_only=on")
    return rh.build(tool="fiberhmm-call", cl=cl, table=call_table(), **kwargs)


def real_parse(args):
    """argv as the real fiberhmm-call parser reads it (FiberHMM's own capture of it)."""
    from fiberhmm.pipeline.runner import _call_parser
    return vars(_call_parser().parse_args(args))


def rewrite(result, flag):
    return next(r for r in result["rewrites"] if r["flag"] == flag)


# --- reading the command line -------------------------------------------------

def test_a_script_path_program_is_ignored_and_every_option_is_carried(tmp_path):
    reads = make_bam(tmp_path / "aligned" / "s01.aligned.sorted.bam")
    result = build(S01_CL.format(input=reads), tmp_path, cores=4)
    args = result["args"]
    assert args[:2] == ["-i", reads]  # .../cli/call.py is not an argument
    for carried in ("--enzyme dddb", "--seq nanopore", "--mode daf", "--primary", "--min-mapq 20",
                    "--min-read-length 500", "--prob-threshold 128", "--dedup", "-c 4", "--io-threads 2",
                    "--no-qc", "--region-parallel", "--chroms chr2L"):
        assert carried in " ".join(args), carried
    # Only the outputs and the job's progress file changed, and each change is listed.
    assert {r["flag"] for r in result["rewrites"]} == {"-o", "--daf-snp-output-prefix", "--progress-json"}


def test_relative_outputs_go_into_the_new_folder_with_their_names(tmp_path):
    reads = make_bam(tmp_path / "aligned.bam")
    result = build(S01_CL.format(input=reads), tmp_path)
    out = str(tmp_path / "out")
    assert rewrite(result, "-o") == {"flag": "-o", "from": "calls/s01.fixed.dddb.bam",
                                     "to": os.path.join(out, "s01.fixed.dddb.bam"), "why": "into the re-call's folder"}
    assert rewrite(result, "--daf-snp-output-prefix")["to"] == os.path.join(out, "s01")
    assert result["output_bam"] == os.path.join(out, "s01.fixed.dddb.bam")


def test_every_output_prefix_the_parser_declares_is_redirected(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    cl = (f"fiberhmm-call -i {reads} -o /elsewhere/x.bam --enzyme dddb --qc-output-prefix /elsewhere/qc/x "
          "--dedup-stats-tsv /elsewhere/d.tsv --work-dir /elsewhere/work --progress-json /elsewhere/p.jsonl")
    result = build(cl, tmp_path)
    out = str(tmp_path / "out")
    assert rewrite(result, "--qc-output-prefix")["to"] == os.path.join(out, "x")
    assert rewrite(result, "--dedup-stats-tsv")["to"] == os.path.join(out, "d.tsv")
    assert rewrite(result, "--work-dir")["to"] == os.path.join(out, "work")
    assert rewrite(result, "--progress-json")["to"] == rh.PROGRESS_PLACEHOLDER
    assert not any(a.startswith("/elsewhere") for a in result["args"])


def test_a_header_cannot_point_an_output_outside_the_new_folder(tmp_path):
    # The CL is text inside a BAM: "--work-dir .." would make fiberhmm-call delete the parent folder after
    # a successful run, so an output without a file name of its own is refused.
    reads = make_bam(tmp_path / "in.bam")
    for value in ("..", ".", "/"):
        with pytest.raises(rh.CommandError, match="no file name"):
            build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --work-dir {value}", tmp_path)
    result = build(f"fiberhmm-call -i {reads} -o ../../../etc/x.bam --enzyme dddb", tmp_path)
    assert result["output_bam"] == str(tmp_path / "out" / "x.bam")
    # The progress placeholder is only ever the --progress-json value.
    plan = {"extra": ["--phase-nrl", rh.PROGRESS_PLACEHOLDER, "--progress-json", rh.PROGRESS_PLACEHOLDER]}
    assert jobs._header_job_args(plan, "/jobs/1/progress.jsonl") == [
        "--phase-nrl", rh.PROGRESS_PLACEHOLDER, "--progress-json", "/jobs/1/progress.jsonl"]


def test_a_relative_input_is_not_guessed(tmp_path):
    with pytest.raises(rh.CommandError, match="relative to a folder") as refused:
        build("fiberhmm-call -i aligned/x.bam -o x.called.bam --enzyme dddb", tmp_path)
    assert refused.value.needs_input == {"flag": "-i", "recorded": "aligned/x.bam", "reason": "relative"}
    # ...until the user points at it.
    chosen = make_bam(tmp_path / "picked.bam")
    result = build("fiberhmm-call -i aligned/x.bam -o x.called.bam --enzyme dddb", tmp_path, input_override=chosen)
    assert result["input"] == {"flag": "-i", "recorded": "aligned/x.bam", "path": chosen, "how": "you chose it"}
    assert rewrite(result, "-i")["why"] == "the file you chose"


def test_a_missing_input_asks_for_the_file(tmp_path):
    with pytest.raises(rh.CommandError, match="not found on this computer") as refused:
        build("fiberhmm-call -i /no/such/place/reads.bam -o x.bam --enzyme dddb", tmp_path)
    assert refused.value.needs_input["reason"] == "missing"


def test_a_renamed_flag_is_mapped_and_shown(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    result = build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --seq nanopore --force-chemistry", tmp_path)
    assert "--force-seq" in result["args"] and "--force-chemistry" not in result["args"]
    assert rewrite(result, "--force-seq")["from"] == "--force-chemistry"


def test_an_unknown_or_retired_flag_is_refused_by_name(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    with pytest.raises(rh.CommandError, match="--frobnicate"):
        build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --frobnicate 3", tmp_path)
    with pytest.raises(rh.CommandError, match="fiberhmm-tag-m5c"):
        build(f"fiberhmm-call -i {reads} -o x.bam --enzyme ddda --ddda-mcg", tmp_path)
    with pytest.raises(rh.CommandError, match="pipe"):
        build(f"fiberhmm-call -i {reads} -o - --enzyme dddb", tmp_path)


def test_the_core_count_is_the_librarys(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    result = build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --cores 16", tmp_path, cores=3)
    assert rewrite(result, "--cores") == {"flag": "--cores", "from": "16", "to": "3", "why": "the Library's core count"}
    result = build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb", tmp_path, cores=3)
    assert real_parse(result["args"])["cores"] == 3 and rewrite(result, "--cores")["from"] is None


def test_an_unquoted_command_with_spaces_from_another_computer(tmp_path):
    """amp_DddB: written on WSL (/mnt/d/Dropbox/...), read here under the home folder."""
    here = tmp_path / "Dropbox" / "project" / "FiberHMM runs" / "runs"
    reads = make_bam(here / "input" / "amp_dddb_bulk_2-4h.raw.bam")
    entry = make_fiberhmm_bam(tmp_path / "Dropbox" / "package" / "amp_DddB.full.bam")
    cl = AMP_CL.format(root="/mnt/d/Dropbox/project/FiberHMM runs/runs")
    result = build(cl, tmp_path, entry_path=entry, ds=AMP_DS)
    assert result["input"]["path"] == reads
    assert result["input"]["recorded"] == "/mnt/d/Dropbox/project/FiberHMM runs/runs/input/amp_dddb_bulk_2-4h.raw.bam"
    assert "/mnt/d" in result["input"]["how"]
    assert any("not shell-quoted" in w for w in result["warnings"])  # shown for confirmation
    assert any("not found where the header records it" in w for w in result["warnings"])
    parsed = real_parse(result["args"])
    assert parsed["input"] == reads and parsed["chroms"] == ["chr3L"] and parsed["io_threads"] == 4
    assert parsed["output"] == str(tmp_path / "out" / "amp_dddb.full.bam")
    assert parsed["daf_snp_output_prefix"] == str(tmp_path / "out" / "amp_dddb.full")
    assert parsed["seq"] == "nanopore" and rewrite(result, "--seq")["from"] is None  # the platform it declared


def test_defaults_changed_since_the_original_run_are_listed_and_can_be_kept(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    cl = f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb"
    # A 2.x run (its DS records no alignment choice) called every alignment.
    result = build(cl, tmp_path, ds=AMP_DS)
    changes = {c["id"]: c for c in result["changed_defaults"]}
    assert changes["alignments"]["text"].startswith("FiberHMM 3.0 calls primary and supplementary alignments")
    assert changes["alignments"]["restore"] == ["--alignments", "all"] and not changes["alignments"]["kept_old"]
    assert changes["alignments"]["dest"] == "alignments"
    assert changes["tf_decoder"]["restore"] is None and "4.0" in changes["tf_decoder"]["text"]
    assert real_parse(result["args"])["alignments"] == "primary-supplementary"
    kept = build(cl, tmp_path, ds=AMP_DS, keep_old=["alignments"])
    assert real_parse(kept["args"])["alignments"] == "all" and rewrite(kept, "--alignments")
    with pytest.raises(rh.CommandError, match="no original behaviour"):
        build(cl, tmp_path, ds=AMP_DS, keep_old=["tf_decoder"])


def test_fiberhmm_3_changed_defaults_supplementary_and_unaligned_mask(tmp_path):
    """A 3.0 run from before supplementary calling (DS primary_only=on, no alignments=, no
    daf_unaligned_mask=): both new defaults listed, each with the flag that keeps the original."""
    reads = make_bam(tmp_path / "in.bam")
    cl = f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb"
    old_ds = "tf_decoder=multi_interval_v1 primary_only=on daf_run_mask=off"
    changes = {c["id"]: c for c in build(cl, tmp_path, ds=old_ds)["changed_defaults"]}
    assert changes["alignments"]["text"] == rh.SUPPLEMENTARY_TEXT
    assert "supplementary alignments" in changes["alignments"]["text"]
    assert changes["alignments"]["restore"] == ["--alignments", "primary"]
    assert changes["daf_unaligned_mask"]["text"] == rh.UNALIGNED_MASK_TEXT
    assert "inserted and soft-clipped bases" in rh.UNALIGNED_MASK_TEXT
    assert changes["daf_unaligned_mask"]["restore"] == ["--no-daf-mask-unaligned"]
    kept = build(cl, tmp_path, ds=old_ds, keep_old=["alignments", "daf_unaligned_mask"])
    parsed = real_parse(kept["args"])
    assert parsed["alignments"] == "primary" and parsed["daf_mask_unaligned"] is False
    before = real_parse(kept["original_args"])
    assert rh.silent_changes(before, parsed, rh.allowed_changes("fiberhmm-call", kept)) == []
    # A run made with the new defaults (its DS records them) changed nothing there.
    new_ds = old_ds + " alignments=primary-supplementary daf_unaligned_mask=on daf_insert_consensus=on/0of0/min20"
    assert not {"alignments", "daf_unaligned_mask"} & {c["id"] for c in build(cl, tmp_path, ds=new_ds)["changed_defaults"]}
    # An explicit choice is carried, never listed (old --primary / --no-primary are now --alignments aliases).
    for flag, value in (("--primary", "primary"), ("--no-primary", "all"), ("--alignments primary", "primary")):
        result = build(f"{cl} {flag} --no-daf-mask-unaligned", tmp_path, ds=old_ds)
        assert not {"alignments", "daf_unaligned_mask"} & {c["id"] for c in result["changed_defaults"]}
        assert real_parse(result["args"])["alignments"] == value


def test_retired_nucleosome_options_are_dropped_and_listed_not_refused(tmp_path):
    """--phase-nrl and --nuc-recall-policy (retired in 3.0: they caused artifacts) are left out of
    the re-call and listed as rewrites, in every spelling; the rest round-trips."""
    reads = make_bam(tmp_path / "in.bam")
    cl = (f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --phase-nrl auto --min-llr 6 "
          "--nuc-recall-policy=topology --primary")
    result = build(cl, tmp_path, ds=S01_DS)
    dropped = {r["flag"]: r for r in result["rewrites"] if r["to"] is None}
    assert dropped == {
        "--phase-nrl": {"flag": "--phase-nrl", "from": "auto", "to": None, "why": rh.RETIRED_CAUSED_ARTIFACTS},
        "--nuc-recall-policy": {"flag": "--nuc-recall-policy", "from": "topology", "to": None,
                                "why": rh.RETIRED_CAUSED_ARTIFACTS}}
    assert rh.RETIRED_CAUSED_ARTIFACTS == "retired in FiberHMM 3.0: caused artifacts"
    assert "--phase-nrl" not in result["args"] and "--nuc-recall-policy=topology" not in result["args"]
    assert not any(w.startswith(("--phase-nrl", "--nuc-recall-policy")) for w in result["original_args"])
    before, after = real_parse(result["original_args"]), real_parse(result["args"])
    assert after["min_llr"] == 6 and after["alignments"] == "primary"
    assert after["phase_nrl"] == "off" and after["nuc_recall_policy"] == "auto"  # FiberHMM's defaults
    assert rh.silent_changes(before, after, rh.allowed_changes("fiberhmm-call", result)) == []
    assert not result["warnings"]
    # A fixed-bp value, an unquoted command (the value is the next word) and the last word.
    result = build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --phase-nrl 185 --nuc-recall-policy",
                   tmp_path, ds=S01_DS)
    assert [(r["flag"], r["from"]) for r in result["rewrites"] if r["to"] is None] == [
        ("--phase-nrl", "185"), ("--nuc-recall-policy", None)]
    # A run that used them by default (DS) is told its nucleosome calls change; nothing restores them.
    changes = {c["id"]: c for c in build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb", tmp_path,
                                         ds=S01_DS + " phase_nrl=auto nuc_recall_policy=auto")["changed_defaults"]}
    assert changes["nuc_recall"]["restore"] is None and "phase_nrl=auto" in changes["nuc_recall"]["text"]


def test_retired_options_in_a_pipeline_commands_call_args_are_dropped(tmp_path):
    from fiberhmm.cli.pipeline import parse_args
    reads = make_bam(tmp_path / "in.bam")
    ref = tmp_path / "ref.fa"
    ref.write_text(">c\nACGT\n")
    result = build_pipeline(f"fiberhmm-pipeline {reads} --reference {ref} --enzyme dddb -o /old/out "
                            "--call-args '--phase-nrl auto --with-scores'", tmp_path)
    assert [(r["flag"], r["from"], r["to"]) for r in result["rewrites"] if r["to"] is None] == [
        ("--call-args --phase-nrl", "auto", None)]
    assert parse_args(result["args"]).call_args == "--with-scores" and result["call_args"] == ["--with-scores"]
    before, after = vars(parse_args(result["original_args"])), vars(parse_args(result["args"]))
    assert rh.silent_changes(before, after, rh.allowed_changes("fiberhmm-pipeline", result)) == []
    # Only a retired option: --call-args goes altogether.
    result = build_pipeline(f"fiberhmm-pipeline {reads} --reference {ref} --enzyme dddb -o /old/out "
                            "--call-args '--nuc-recall-policy topology'", tmp_path)
    assert parse_args(result["args"]).call_args == ""  # kept, emptied: see below
    # An old pipeline (its DS records no alignment set): its three changed defaults, kept on request.
    changes = {c["id"]: c for c in result["changed_defaults"]}
    assert set(changes) == {"alignments", "soft_clips", "daf_unaligned_mask"}
    assert changes["soft_clips"]["text"] == rh.SOFT_CLIP_TEXT and "linear contigs" in rh.SOFT_CLIP_TEXT
    assert changes["soft_clips"]["restore"] == ["--hard-clip"]
    kept = build_pipeline(f"fiberhmm-pipeline {reads} --reference {ref} --enzyme dddb -o /old/out", tmp_path,
                          keep_old=["alignments", "soft_clips", "daf_unaligned_mask"])
    args = parse_args(kept["args"])
    assert args.alignments == "primary" and args.hard_clip and args.daf_mask_unaligned is False


def test_the_recall_round_trips_through_the_real_fiberhmm_call_parser(tmp_path):
    """Every option the original set parses to the same value; only the listed rewrites differ."""
    reads = make_bam(tmp_path / "aligned.bam")
    result = build(S01_CL.format(input=reads), tmp_path, cores=4, ds=S01_DS)
    before, after = real_parse(result["original_args"]), real_parse(result["args"])
    changed = {k for k in before if before[k] != after[k]}
    assert changed == {"output", "daf_snp_output_prefix", "progress_json"}
    assert rh.silent_changes(before, after, rh.allowed_changes("fiberhmm-call", result)) == []
    assert after["dedup"] is True and after["qc"] is False and after["alignments"] == "primary"
    assert after["prob_threshold"] == 128 and after["min_read_length"] == 500 and after["mode"] == "daf"


# --- review round 1 (Codex) ----------------------------------------------------

def pipeline_table() -> rh.Table:
    if "pipeline" not in _TABLE:
        proc = subprocess.run([sys.executable, "-c", rh.PARSER_PROBE, "fiberhmm.cli.pipeline", "", "table"],
                              capture_output=True, text=True, timeout=120)
        _TABLE["pipeline"] = rh.Table("fiberhmm-pipeline", json.loads(proc.stdout.strip().splitlines()[-1]))
    return _TABLE["pipeline"]


def build_pipeline(cl, tmp_path, **kwargs):
    kwargs.setdefault("entry_path", str(tmp_path / "entry.bam"))
    return rh.build(tool="fiberhmm-pipeline", cl=cl, table=pipeline_table(), enzyme="dddb", platform="nanopore",
                    outdir=str(tmp_path / "out"), cores=2, ds="", call_table=call_table(), **kwargs)


def test_repeated_cores_and_progress_options_are_all_rewritten(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    result = build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb -c4 -c 99 --progress-json /old/a "
                   "--progress-json /old/b", tmp_path, cores=2)
    parsed = real_parse(result["args"])
    assert parsed["cores"] == 2 and parsed["progress_json"] == rh.PROGRESS_PLACEHOLDER


def test_an_unknown_option_before_the_input_is_refused_not_taken_for_the_program(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    with pytest.raises(rh.CommandError, match="--old-setting"):
        build(f"/env/bin/fiberhmm-call --old-setting 9 -i {reads} -o x.bam --enzyme dddb", tmp_path)
    # A program path with spaces still ends at the tool's name.
    result = build(f"/Users/me/my env/bin/fiberhmm-call -i {reads} -o x.bam --enzyme dddb", tmp_path)
    assert result["args"][:2] == ["-i", reads]


def test_an_input_path_with_spaces_is_bound_by_the_plan(tmp_path):
    reads = make_bam(tmp_path / "in.bam")
    model = tmp_path / "my models" / "table v1.json"
    model.parent.mkdir()
    model.write_text("{}")
    result = build(f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb -m {model}", tmp_path)
    assert str(model) in result["input_files"] and real_parse(result["args"])["model"] == str(model)
    plan = {"reads": [reads], "reference": {}, "extra": result["args"], "input_files": result["input_files"]}
    before = [jobs._file_identity(p) for p in jobs._plan_inputs(plan)]
    model.write_text('{"changed": 1}')
    assert [jobs._file_identity(p) for p in jobs._plan_inputs(plan)] != before


def test_a_read_folder_is_bound_file_by_file(tmp_path):
    folder = tmp_path / "reads"
    make_bam(folder / "a.bam")
    plan = {"reads": [str(folder)], "reference": {}, "extra": []}
    before = [jobs._file_identity(p) for p in jobs._plan_inputs(plan)]
    assert str(folder / "a.bam") in jobs._plan_inputs(plan)
    with open(folder / "a.bam", "ab") as handle:
        handle.write(b"x")
    assert [jobs._file_identity(p) for p in jobs._plan_inputs(plan)] != before


def test_one_chosen_file_does_not_replace_several_reads(tmp_path):
    cl = "fiberhmm-pipeline /gone/a.bam /gone/b.bam --reference /gone/ref.fa --enzyme dddb -o /old/out"
    with pytest.raises(rh.CommandError, match="several files"):
        build_pipeline(cl, tmp_path, input_override=make_bam(tmp_path / "picked.bam"))


def test_a_dash_leading_value_keeps_its_attached_form(tmp_path):
    from fiberhmm.cli.pipeline import parse_args
    reads = make_bam(tmp_path / "in.bam")
    ref = tmp_path / "ref.fa"
    ref.write_text(">chr2L\nACGT\n")
    result = build_pipeline(f"fiberhmm-pipeline {reads} --reference {ref} --enzyme dddb -o /old/out "
                            "'--call-args=--with-scores'", tmp_path)
    assert "--call-args=--with-scores" in result["args"]
    assert parse_args(result["args"]).call_args == "--with-scores"


def test_pipeline_remedies_follow_the_effective_settings(tmp_path):
    entry = {"path": str(tmp_path / "x.bam"), "advisories": {"items": [DEDUP, GT]}}
    facts = {"path": str(tmp_path / "reads.bam"), "is_entry": False, "fiberhmm_output": False}
    with pytest.raises(jobs.RecallError, match="turned duplicate marking off") as refused:
        jobs._header_remedy(entry, "fiberhmm-pipeline", {"flags": []}, {"dedup": "off", "qc": True}, facts, "dddb",
                            {"dedup": None, "model": "/old/table.json"})
    assert "its own table (-m in --call-args)" in str(refused.value)
    fixed, _ = jobs._header_remedy(entry, "fiberhmm-pipeline", {"flags": []}, {"dedup": "auto", "qc": True}, facts,
                                   "dddb", {"dedup": None, "model": None})
    assert fixed == ["daf-dedup-orientation", "dddb-gt-table"]
    # --call-args "--no-ded" (an abbreviation fiberhmm-call's parser accepts) turns marking off there.
    fixed, not_fixed = jobs._header_remedy(entry, "fiberhmm-pipeline", {"flags": []}, {"dedup": "on", "qc": True},
                                           facts, "dddb", {"dedup": False, "model": None})
    assert fixed == ["dddb-gt-table"] and not_fixed[0]["id"] == "daf-dedup-orientation"


def test_a_pipeline_commands_call_args_are_read_with_fiberhmm_calls_parser(tmp_path):
    table = call_table()
    model = tmp_path / "table.json"
    model.write_text("{}")
    assert rh.nested_call_args(f"--with-scores -m{model}", table, os.path.exists) == [str(model)]
    for refused, why in (("-c99", "sets itself"), ("--output=/elsewhere/x.bam", "sets itself"),
                         ("--dedup-stats /elsewhere/d.tsv", "sets itself"), ("--qc-out /x/q", "sets itself"),
                         ("--frobnicate", "--frobnicate"), ("-m tables/t.json", "relative"),
                         ("--model /gone/t.json", "not found")):
        with pytest.raises(rh.CommandError, match=why):
            rh.nested_call_args(refused, table, os.path.exists)


def test_a_pipeline_header_recall_needs_a_new_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -m fiberhmm.cli.pipeline")
    reads = make_bam(tmp_path / "reads.bam")
    ref = tmp_path / "ref.fa"
    ref.write_text(">chr2L\nACGT\n")
    cl = f"fiberhmm-pipeline {reads} --reference {ref} --enzyme dddb -o /old/run --redo all"
    bam = make_fiberhmm_bam(tmp_path / "package" / "p.bam", comments=[DDDB_DECLARATION], programs=[
        {"ID": "fiberhmm-pipeline", "PN": "fiberhmm-pipeline", "VN": "3.0.0", "CL": cl}])
    entry = _entry(bam, advisories={"key": "x", "items": []})
    (tmp_path / "earlier").mkdir()
    (tmp_path / "earlier" / "S1.fiberhmm.bam").write_bytes(b"earlier")
    with pytest.raises(jobs.RecallError, match="never overwrites"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "earlier"), cores=2)
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "fresh"), cores=2)
    assert plan["tool"] == "fiberhmm-pipeline" and plan["reads"] == [reads]
    assert plan["display_command"].startswith(f"fiberhmm-pipeline {reads} --reference {ref}")
    assert "--redo all" in plan["display_command"] and str(tmp_path / "fresh") in plan["display_command"]


def test_files_written_beside_a_prefix_are_never_overwritten(tmp_path):
    reads = make_bam(tmp_path / "aligned.bam")
    entry = _called(tmp_path, f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --qc-output-prefix /old/report")
    (tmp_path / "recall").mkdir()
    (tmp_path / "recall" / "report.qc.json").write_text("{}")
    with pytest.raises(jobs.RecallError, match="report.qc.json"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)
    (tmp_path / "recall" / "report.qc.json").unlink()
    (tmp_path / "recall" / "qc").mkdir()
    (tmp_path / "recall" / "qc" / "x.dedup.json").write_text("{}")
    with pytest.raises(jobs.RecallError, match="x.dedup.json"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)


def test_a_custom_qc_prefix_is_the_jobs_qc(tmp_path):
    from services.pipeline_jobs import call_outputs
    bam = make_bam(tmp_path / "x.bam")
    (tmp_path / "custom.qc.json").write_text("{}")
    assert call_outputs(bam, str(tmp_path / "custom"))["qc"] == {"json": str(tmp_path / "custom.qc.json")}
    assert call_outputs(bam)["qc"] is None and call_outputs(str(tmp_path / "gone.bam")) is None


# --- planning from the Library ------------------------------------------------

def _entry(path, **extra):
    info = inspect.inspect_file(path)
    info.update(extra)
    entry_id = store.record(info)["id"]
    return store.load()["entries"][entry_id]


def _called(tmp_path, cl, ds=S01_DS, advisories=(DEDUP,), name="called.bam"):
    bam = make_fiberhmm_bam(tmp_path / "package" / name, comments=[DDDB_DECLARATION], programs=[
        {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "2.16.8", "CL": cl, "DS": ds}])
    return _entry(bam, advisories={"key": "x", "items": list(advisories)})


def test_the_dedup_advisory_is_fixed_from_the_undeduplicated_input(tmp_path):
    reads = make_bam(tmp_path / "aligned" / "s01.aligned.sorted.bam")
    entry = _called(tmp_path, S01_CL.format(input=reads))
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)
    assert plan["tool"] == "fiberhmm-call" and plan["settings"]["source"] == "BAM header"
    assert plan["reads"] == [reads] and plan["advisories_fixed"] == ["daf-dedup-orientation"]
    assert plan["header"]["command_line"] == S01_CL.format(input=reads)
    assert plan["display_command"].startswith(f"fiberhmm-call -i {reads} -o ")
    assert plan["header"]["not_fixed"] == [] and plan["output_bam"] == str(tmp_path / "recall" / "s01.fixed.dddb.bam")


def test_the_dedup_advisory_is_refused_when_the_input_is_not_the_undeduplicated_reads(tmp_path):
    called_input = make_fiberhmm_bam(tmp_path / "older" / "calls.bam")  # a FiberHMM output as the input
    entry = _called(tmp_path, S01_CL.format(input=called_input))
    with pytest.raises(jobs.RecallError, match="itself FiberHMM output"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)
    # The re-call would not mark duplicates.
    reads = make_bam(tmp_path / "aligned.bam")
    entry = _called(tmp_path, S01_CL.format(input=reads).replace("--dedup", "--no-dedup"), name="nodedup.bam")
    with pytest.raises(jobs.RecallError, match="turned duplicate marking off"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)


def test_the_dedup_advisory_does_not_block_the_table_fix(tmp_path):
    called_input = make_fiberhmm_bam(tmp_path / "older" / "calls.bam")
    entry = _called(tmp_path, S01_CL.format(input=called_input), advisories=(GT, DEDUP))
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)
    assert plan["advisories_fixed"] == ["dddb-gt-table"]
    assert [n["id"] for n in plan["header"]["not_fixed"]] == ["daf-dedup-orientation"]
    # A custom table in the command would repeat the table problem.
    table = tmp_path / "old_table.json"
    table.write_text("{}")
    reads = make_bam(tmp_path / "aligned.bam")
    entry = _called(tmp_path, f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb -m {table}", advisories=(GT,),
                    name="custom.bam")
    with pytest.raises(jobs.RecallError, match="its own table"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)


def test_an_advisory_the_call_cannot_fix_keeps_fiberhmms_own_fix(tmp_path):
    reads = make_bam(tmp_path / "aligned.bam")
    tfs = {"id": "tag-m5c-missing-ucg", "severity": "rerun-recommended", "title": "tag-m5c",
           "fix": "Re-run fiberhmm-tag-m5c with FiberHMM >= 3.0, then fiberhmm-call again on the tagged BAM"}
    entry = _called(tmp_path, S01_CL.format(input=reads), advisories=(tfs,))
    with pytest.raises(jobs.RecallError, match="tag-m5c: Re-run fiberhmm-tag-m5c"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)


def test_the_plan_binds_the_header_command_its_input_and_the_choices(tmp_path, monkeypatch):
    from services import pipeline_jobs
    reads = make_bam(tmp_path / "aligned.bam")
    entry = _called(tmp_path, f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb", ds=AMP_DS)
    options = {"outdir": str(tmp_path / "recall"), "cores": 2}
    reviewed = jobs.plan_recall(entry, **options)
    assert jobs.plan_recall(entry, **options)["plan_id"] == reviewed["plan_id"]
    assert jobs.plan_recall(entry, keep_old=["alignments"], **options)["plan_id"] != reviewed["plan_id"]
    manager = type("M", (), {"root": str(tmp_path / "jobs"), "created": {},
                             "create": lambda self, spec, admit=None: self.created.update(spec) or {"id": spec["id"]}})()
    monkeypatch.setattr(pipeline_jobs, "get_job_manager", lambda: manager)
    with open(reads, "ab") as handle:  # the input changed after the review
        handle.write(b"x")
    with pytest.raises(jobs.RecallError, match="changed since it was shown"):
        jobs.submit_recall(entry, plan_id=reviewed["plan_id"], **options)
    assert manager.created == {}


def test_an_existing_output_is_never_overwritten(tmp_path):
    reads = make_bam(tmp_path / "aligned.bam")
    entry = _called(tmp_path, f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb")
    (tmp_path / "recall").mkdir()
    (tmp_path / "recall" / "x.bam").write_bytes(b"earlier")
    with pytest.raises(jobs.RecallError, match="never overwrites"):
        jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=2)


def test_the_job_runs_fiberhmm_call_resolved_like_the_pipeline(monkeypatch):
    from services import pipeline_inputs as pi
    monkeypatch.delenv("FIBERBROWSER_CALL_COMMAND", raising=False)
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -X utf8 -m fiberhmm.cli.pipeline")
    assert pi.call_command()["argv"] == [sys.executable, "-X", "utf8", "-m", "fiberhmm.cli.call"]
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", "/opt/somewhere/run-pipeline")
    assert pi.call_command()["argv"] is None and pi.CALL_ENV in pi.call_command()["hint"]


def test_fiberhmm_call_progress_is_one_call_step():
    from services.pipeline_jobs import summarize_progress
    events = [{"schema": "fiberhmm.progress.v1", "tool": "fiberhmm-call", "event": "start", "regions_total": 4,
               "regions_done": 0},
              {"schema": "fiberhmm.progress.v1", "tool": "fiberhmm-call", "event": "region", "regions_done": 1,
               "regions_total": 4, "reads_per_s": 10.0, "eta_s": 30.0}]
    progress = summarize_progress(events)
    assert progress["current_step"] == "call" and progress["fraction"] == 0.25 and progress["done"] is None
    events.append({"schema": "fiberhmm.progress.v1", "tool": "fiberhmm-call", "event": "done"})
    progress = summarize_progress(events)
    assert progress["steps"][0]["status"] == "done" and progress["done"] is None  # the exit status decides


# --- end to end: a real fiberhmm-call job, imported into the Library ----------

def _daf_reads(path, n_reads=30, read_length=1500, length=40_000):
    """Aligned DddB reads in R/Y encoding (st tags), as FiberHMM's own synthetic fixtures."""
    import random
    rng = random.Random(7)
    reference = "".join(rng.choice("ACGT") for _ in range(length))
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr2L", "LN": length}],
              "PG": [{"ID": "minimap2", "PN": "minimap2", "VN": "2.28", "CL": "minimap2 -ax map-ont ref.fa r.fq"}]}
    unsorted = str(path) + ".unsorted.bam"
    os.makedirs(os.path.dirname(str(path)), exist_ok=True)
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for i in range(n_reads):
            start = rng.randrange(0, length - read_length)
            plus = i % 2 == 0
            bases = [("Y" if plus else "R") if b == ("C" if plus else "G") and rng.random() < 0.15 else b
                     for b in reference[start:start + read_length]]
            read = pysam.AlignedSegment()
            read.query_name = f"r{i:03d}"
            read.query_sequence = "".join(bases)
            read.query_qualities = pysam.qualitystring_to_array("I" * read_length)
            read.set_tag("st", "CT" if plus else "GA", value_type="Z")
            read.flag, read.reference_id, read.reference_start = 0, 0, start
            read.mapping_quality, read.cigar = 60, [(0, read_length)]
            out.write(read)
    pysam.sort("-o", str(path), unsorted)
    os.remove(unsorted)
    pysam.index(str(path))
    return str(path)


@pytest.mark.slow
def test_a_header_recall_runs_and_joins_the_library(tmp_path):
    from fiberhmm import __version__ as current
    from services import pipeline_jobs
    reads = _daf_reads(tmp_path / "plasmid" / "aligned" / "s01.aligned.sorted.bam")
    cl = S01_CL.format(input=reads).replace("-c 4 --io-threads 2", "-c 1 --io-threads 1")
    entry = _called(tmp_path, cl)
    plan = jobs.plan_recall(entry, outdir=str(tmp_path / "recall"), cores=1)
    job = jobs.submit_recall(entry, outdir=str(tmp_path / "recall"), cores=1, plan_id=plan["plan_id"])
    manager = pipeline_jobs.get_job_manager()
    deadline = time.time() + 240
    while manager.state(job["id"]).get("status") in ("queued", "running", "cancelling") and time.time() < deadline:
        manager.tick()
        time.sleep(0.5)
    state = manager.state(job["id"])
    assert state["status"] == "done", manager.read_log(job["id"])
    assert state["outputs"]["called_bam"] == plan["output_bam"]
    described = manager.describe(job["id"])
    assert described["progress"]["steps"][0]["name"] == "call" and described["progress"]["steps"][0]["status"] == "done"
    assert jobs.import_finished_jobs()["imported"] == 1
    new = next(e for e in store.load()["entries"].values() if e["path"] == plan["output_bam"])
    assert new["job"]["recall_of"] == entry["id"] and new["chemistry"]["key"] == "dddb"
    with pysam.AlignmentFile(plan["output_bam"], check_sq=False) as bam:
        programs = bam.header.to_dict()["PG"]
    made = rh.calling_program(programs)
    assert made["name"] == "fiberhmm-call" and made["version"] == current and current.startswith("3.")
    assert "dedup=" in made["ds"] and "off" not in made["ds"].split("dedup=")[1].split()[0]


def test_an_emptied_last_call_args_never_revives_an_overridden_one(tmp_path):
    """Codex review: argparse keeps the last --call-args; dropping it whole would make an earlier
    one (overridden in the original) take effect."""
    from fiberhmm.cli.pipeline import parse_args
    reads = make_bam(tmp_path / "in.bam")
    ref = tmp_path / "ref.fa"
    ref.write_text(">c\nACGT\n")
    result = build_pipeline(f"fiberhmm-pipeline {reads} --reference {ref} --enzyme dddb -o /old/out "
                            "--call-args '--min-llr 6' --call-args '--phase-nrl auto'", tmp_path)
    assert parse_args(result["original_args"]).call_args == "--phase-nrl auto"  # the last one wins
    assert parse_args(result["args"]).call_args == "" and result["call_args"] == []
    assert [(r["flag"], r["from"]) for r in result["rewrites"] if r["to"] is None] == [("--call-args --phase-nrl", "auto")]


@pytest.mark.parametrize("with_table", [True, False])
def test_abbreviated_retired_options_are_dropped_by_their_full_name(with_table):
    """Codex review: fiberhmm-call's parser accepts unique prefixes (--phase-n=185); they are retired too."""
    table = call_table() if with_table else None
    kept, dropped = rh.drop_retired(["--phase-n=185", "--min-llr", "6", "--nuc-recall-pol", "topology",
                                     "--with-scores"], table)
    assert kept == ["--min-llr", "6", "--with-scores"]
    assert [(d["flag"], d["value"]) for d in dropped] == [("--phase-nrl", "185"), ("--nuc-recall-policy", "topology")]
    # Another option's own name is never taken for one.
    assert rh.drop_retired(["--min-llr", "6", "--min-opps", "3"], table)[1] == []


def test_abbreviated_retired_options_once_the_parser_has_removed_them(tmp_path):
    """Codex review: when fiberhmm-call no longer has --phase-nrl, '--phase-n=185' matches no
    current option; it is still the retired one, dropped and listed (not refused as unknown)."""
    probe = {"version": call_table().version, "allow_abbrev": True,
             "actions": [a for a in call_table().actions if a["dest"] not in rh.DROPPED_DESTS]}
    table = rh.Table("fiberhmm-call", probe)
    assert not table.has("--phase-nrl")
    kept, dropped = rh.drop_retired(["--phase-n=185", "--min-llr", "6"], table)
    assert kept == ["--min-llr", "6"] and [d["flag"] for d in dropped] == ["--phase-nrl"]
    reads = make_bam(tmp_path / "in.bam")
    result = rh.build(tool="fiberhmm-call", cl=f"fiberhmm-call -i {reads} -o x.bam --enzyme dddb --nuc-recall-pol topology",
                      ds=S01_DS, table=table, entry_path=str(tmp_path / "entry.bam"), enzyme="dddb",
                      platform="nanopore", outdir=str(tmp_path / "out"), cores=2)
    assert [(r["flag"], r["from"]) for r in result["rewrites"] if r["to"] is None] == [("--nuc-recall-policy", "topology")]


# --- raw Nanopore (POD5) pipelines and basecaller overrides (FiberHMM 3.0) ----------

def test_a_pipeline_command_from_pod5_is_never_basecalled_again(tmp_path):
    pod5 = tmp_path / "yw" / "run1" / "pod5"
    pod5.mkdir(parents=True)
    (pod5 / "batch0.pod5").write_bytes(b"POD5")
    ref = tmp_path / "ref.fa"
    ref.write_text(">chrT\n" + "ACGT" * 50 + "\n")
    cl = f"fiberhmm-pipeline {pod5} --reference {ref} --enzyme dddb -o {tmp_path / 'old'} -c 4"
    with pytest.raises(rh.CommandError) as refused:
        build_pipeline(cl, tmp_path)
    assert "basecall everything again" in str(refused.value)
    assert refused.value.needs_input["reason"] == "raw"
    assert os.path.join(str(tmp_path / "old"), "<sample>.basecalled.bam") in str(refused.value)
    # Chosen instead: the run's basecalled BAM (a POD5 file chosen again is refused the same way).
    basecalled = make_bam(tmp_path / "old" / "yw.basecalled.bam", index=False)
    result = build_pipeline(cl, tmp_path, input_override=basecalled)
    assert result["args"][0] == basecalled
    with pytest.raises(rh.CommandError):
        build_pipeline(cl, tmp_path, input_override=str(pod5 / "batch0.pod5"))


def test_a_basecaller_override_recorded_only_in_the_ds_is_given_again(tmp_path):
    reads = make_bam(tmp_path / "aligned.bam")
    ds = ("tf_decoder=multi_interval_v1 primary_only=on basecaller=dorado basecaller_version=0.9.6 "
          "basecall_model=m_override modbase_models=none "
          "basecaller_sources=program:recorded-override,version:override,basecall_model:override,modbase_models:override")
    result = build(f"fiberhmm-call -i {reads} -o out.bam --enzyme dddb", tmp_path, ds=ds)
    args = result["args"]
    assert args[args.index("--basecaller-info") + 1] == "program=dorado version=0.9.6 basecall_model=m_override"
    assert args[args.index("--modbase-model") + 1] == "none"
    why = {r["flag"]: r["why"] for r in result["rewrites"]}
    assert "override the original run recorded" in why["--basecaller-info"]
    before, after = real_parse(result["original_args"]), real_parse(result["args"])
    assert rh.silent_changes(before, after, rh.allowed_changes("fiberhmm-call", result)) == []
    # Already on the command line: carried verbatim, nothing added for it.
    given = build(f"fiberhmm-call -i {reads} -o out.bam --enzyme dddb --modbase-model none "
                  "--basecaller-info program=dorado version=0.9.6 model=m_override", tmp_path, ds=ds)
    assert given["args"].count("--modbase-model") == 1 and given["args"].count("--basecaller-info") == 1
    assert not [r for r in given["rewrites"] if "override" in r["why"]]
    # Detected (not an override): nothing to give again.
    detected = ds.replace("recorded-override", "pg").replace(":override", ":rg_ds")
    plain = build(f"fiberhmm-call -i {reads} -o out.bam --enzyme dddb", tmp_path, ds=detected)
    assert "--basecaller-info" not in plain["args"] and "--modbase-model" not in plain["args"]


def test_a_recorded_override_fills_only_the_fields_the_command_does_not_give(tmp_path):
    reads = make_bam(tmp_path / "aligned.bam")
    ds = ("tf_decoder=multi_interval_v1 primary_only=on basecaller=dorado basecaller_version=0.9.6 "
          "basecall_model=m_override modbase_models=none "
          "basecaller_sources=program:override,version:override,basecall_model:rg_ds,modbase_models:override")
    # --modbase-model on the command line: kept; program and version still added.
    result = build(f"fiberhmm-call -i {reads} -o out.bam --enzyme dddb --modbase-model x_6mA@v1", tmp_path, ds=ds)
    args = result["args"]
    assert args.count("--modbase-model") == 1 and args[args.index("--modbase-model") + 1] == "x_6mA@v1"
    assert args[args.index("--basecaller-info") + 1] == "program=dorado version=0.9.6"
    # A --basecaller-info with some fields: the missing ones join that same value (argparse keeps the last).
    result = build(f"fiberhmm-call -i {reads} -o out.bam --enzyme dddb --basecaller-info basecaller=guppy",
                   tmp_path, ds=ds)
    args = result["args"]
    assert args.count("--basecaller-info") == 1
    assert args[args.index("--basecaller-info") + 1] == "basecaller=guppy version=0.9.6"
    assert args[args.index("--modbase-model") + 1] == "none"
    before, after = real_parse(result["original_args"]), real_parse(result["args"])
    assert rh.silent_changes(before, after, rh.allowed_changes("fiberhmm-call", result)) == []
