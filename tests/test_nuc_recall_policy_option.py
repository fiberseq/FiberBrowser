"""The run wizard's "Nucleosome recall: Conservative (default) / Topology" (3.1.1): fiberhmm-call's
--nuc-recall-policy topology, through fiberhmm-pipeline's --call-args, only for Hia5 and DddB."""
import pytest

from services import pipeline_inputs as pi

HELP = "usage: fiberhmm-pipeline ... --min-mapq MIN_MAPQ --call-args CALL_ARGS"


def _args(enzyme, **opts):
    return pi.option_args(pi.normalize_options(opts), enzyme, HELP)


def test_the_default_is_unchanged():
    assert pi.DEFAULT_OPTIONS["nuc_recall_policy"] == "conservative"
    for enzyme in ("hia5", "dddb", "ddda"):
        assert not any("nuc-recall" in a for a in _args(enzyme))
        assert not any("nuc-recall" in a for a in _args(enzyme, nuc_recall_policy="conservative"))


@pytest.mark.parametrize("enzyme", ["hia5", "dddb"])
def test_topology_is_passed_when_chosen_and_the_chemistry_takes_it(enzyme):
    args = _args(enzyme, nuc_recall_policy="topology")
    assert args.count(pi.TOPOLOGY_CALL_ARGS) == 1 and pi.TOPOLOGY_CALL_ARGS == "--call-args=--nuc-recall-policy topology"
    assert "topology nucleosome recall" in pi.changed_options(pi.normalize_options({"nuc_recall_policy": "topology"}), enzyme)


def test_never_for_ddda_whose_recall_ignores_it():
    assert not any("nuc-recall" in a for a in _args("ddda", nuc_recall_policy="topology"))
    assert "topology nucleosome recall" not in pi.changed_options(pi.normalize_options({"nuc_recall_policy": "topology"}), "ddda")


def test_an_unknown_policy_is_refused_and_a_pipeline_without_call_args_says_so():
    with pytest.raises(pi.InputError):
        pi.normalize_options({"nuc_recall_policy": "radial"})
    assert pi.normalize_options({"nuc_recall_policy": "auto"})["nuc_recall_policy"] == "conservative"
    with pytest.raises(pi.InputError, match="call-args"):
        pi.option_args(pi.normalize_options({"nuc_recall_policy": "topology"}), "hia5", "usage: --min-mapq MIN_MAPQ")


def test_the_python_wrappers_pass_it():
    from browser_client import BrowserClient
    client = object.__new__(BrowserClient)
    body = client._run_body([], {}, "hia5", "", [], 0, {}, 0, "reads", None, nuc_recall_policy="topology")
    assert body["options"]["nuc_recall_policy"] == "topology"
    assert "nuc_recall_policy" not in client._run_body([], {}, "hia5", "", [], 0, {}, 0, "reads", None)["options"]
