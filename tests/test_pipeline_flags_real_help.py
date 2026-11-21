"""The wizard's calling options against the real fiberhmm-pipeline.

test_pipeline_jobs.py::test_option_flags_follow_the_pipelines_help feeds option_args()
handwritten help text. Here every non-default wizard option, for every chemistry, is
spelled from the installed pipeline's own ``--help`` and then parsed by the pipeline's
own argument parser, which must read back the value the wizard asked for.
"""
from __future__ import annotations

import pytest

from services import pipeline_inputs as pi

# One entry per non-default wizard choice: (raw wizard options, {pipeline arg: expected value}).
VARIANTS = [
    ({"dedup": "on"}, {"dedup": "on"}),
    ({"dedup": "off"}, {"dedup": "off"}),
    ({"dedup": "on", "dedup_mode": "collapse"}, {"dedup": "on", "dedup_mode": "collapse"}),
    ({"snp_screen": "on"}, {"snp_screen": "on"}),
    ({"snp_screen": "off"}, {"snp_screen": "off"}),
    ({"snp_mask": "MASK"}, {"snp_mask": "MASK"}),
    ({"chimera_filter": False}, {"chimera_filter": False}),
    ({"alignments": "primary"}, {"alignments": "primary"}),
    ({"alignments": "all"}, {"alignments": "all"}),
    ({"prob_threshold": 200}, {"prob_threshold": 200}),
    ({"use_m5c": "on"}, {"use_m5c": True}),
    ({"use_m5c": "off"}, {"use_m5c": False}),
    ({"cpg_mask_policy": "methylated-only"}, {"cpg_mask_policy": "methylated-only"}),
    ({"min_mapq": 20}, {"min_mapq": 20}),
]
# A new run always passes its MAPQ (owner, 20 Nov 2026): 0, the wizard's default, unless changed.
MAPQ_0 = ["--min-mapq", "0"]
DDDA_ONLY = {"use_m5c", "cpg_mask_policy"}


@pytest.fixture(scope="module")
def real_help():
    import os
    saved = os.environ.pop(pi.PIPELINE_ENV, None)
    try:
        command = pi.pipeline_command()
    finally:
        if saved is not None:
            os.environ[pi.PIPELINE_ENV] = saved
    assert command["argv"] and command["source"] in ("fiberhmm", "path"), command
    text = pi.pipeline_help(command["argv"], command.get("env"))
    assert text and "--enzyme" in text, "fiberhmm-pipeline --help did not run"
    return text


@pytest.fixture(scope="module")
def parser():
    from fiberhmm.cli.pipeline import build_parser
    return build_parser()


@pytest.mark.parametrize("enzyme", sorted(pi.PIPELINE_ENZYMES))
def test_every_wizard_option_is_a_flag_the_real_pipeline_reads_back(enzyme, real_help, parser, tmp_path):
    mask = tmp_path / "mask.bed"
    mask.write_text("chrT\t10\t11\n")
    base = ["reads.fastq", "--reference", "ref.fa", "--enzyme", enzyme, "-o", str(tmp_path / "out")]
    defaults = vars(parser.parse_args(base))
    assert pi.option_args(pi.normalize_options({}), enzyme, real_help) == MAPQ_0
    assert vars(parser.parse_args(base + MAPQ_0))["min_mapq"] == 0

    checked = 0
    for raw, expected in VARIANTS:
        raw = {k: (str(mask) if v == "MASK" else v) for k, v in raw.items()}
        args = pi.option_args(pi.normalize_options(raw), enzyme, real_help)
        if enzyme != "ddda" and DDDA_ONLY & set(raw):
            assert args == MAPQ_0, (raw, args)  # DddA-only options are not sent for other chemistries
            continue
        assert args, raw
        expected = {"min_mapq": 0, **expected}
        parsed = vars(parser.parse_args(base + args))
        for key, value in expected.items():
            want = str(mask) if value == "MASK" else value
            assert parsed[key] == want, (enzyme, raw, args, key, parsed[key])
        # Nothing else changed from the pipeline's defaults.
        assert {k for k in parsed if parsed[k] != defaults[k]} == set(expected), (raw, args)
        checked += 1
    assert checked >= 10
