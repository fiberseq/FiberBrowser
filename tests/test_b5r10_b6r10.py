"""Round-10 fixes: session contact map, session-only figure panels, BLAST DB
identity, virtual-4C O/E coverage, notebook selection hand-off."""
import os
from types import SimpleNamespace

import numpy as np

from models.domain import JupyterState
from models.requests import JupyterBrowserSettingsSnapshotRequest, SessionImportRequest


def test_importing_a_session_without_a_contact_map_unloads_the_old_one():
    from test_sessions_endpoint import _ImportState
    from services.sessions_endpoint import import_session_for_request

    closed = []
    dafc = SimpleNamespace(
        cool_file="/maps/a.mcool", bigbed_file="/maps/a.bb", clr=object(),
        bb=SimpleNamespace(close=lambda: closed.append(True)),
        resolutions=[1000], current_resolution=1000, chroms=["chr1"],
        chrom_expected_cache={("chr1", 1000, False): np.ones(3)}, chrom_expected_computing=set(),
        linked_sessions={"live": {"version": 7}},
    )
    state = _ImportState()
    result = import_session_for_request(state, SessionImportRequest(session={"version": "2.0"}), dafc_state=dafc)
    assert result["contact_map"] is None
    assert dafc.cool_file is None and dafc.clr is None and dafc.bigbed_file is None
    assert dafc.chrom_expected_cache == {}
    assert dafc.linked_sessions == {"live": {"version": 7}}
    assert closed == [True]
    # (Export writes a contact map only while cool_file is set.)


def test_a_session_without_panels_draws_only_its_own_datasets():
    from services.figure.spec import _merge_defaults, build_panels

    def ds(i):
        return SimpleNamespace(id=i, label=i, color="#000", paths=[f"/{i}.bam"], path=f"/{i}.bam", data_type="bam",
                               available_layers={}, to_dict=lambda i=i: {"id": i, "label": i, "data_type": "bam"})
    state = SimpleNamespace(datasets={"A": ds("A"), "B": ds("B")}, dataset_order=["A", "B"])
    assert [p.dataset_id for p in build_panels(state, _merge_defaults({}))] == ["A", "B"]
    assert [p.dataset_id for p in build_panels(state, _merge_defaults({}), default_ids=["A"])] == ["A"]


def test_a_custom_primer_fasta_gets_its_own_blast_db(tmp_path):
    from services.primer_config import (blast_db_source_matches, default_blast_db_prefix,
                                        record_blast_db_source)
    genome = tmp_path / "hg38.fa"
    custom = tmp_path / "hg38_custom.fa"
    genome.write_text(">chr1\nACGT\n")
    custom.write_text(">chr1\nACGTACGT\n")
    state = SimpleNamespace(current_genome="hg38", fasta_path=str(genome))
    assert os.path.basename(default_blast_db_prefix(state, str(genome))) == "hg38"
    assert os.path.basename(default_blast_db_prefix(state, str(custom))) == "hg38_custom"

    prefix = str(tmp_path / "db" / "hg38")
    os.makedirs(os.path.dirname(prefix))
    assert blast_db_source_matches(prefix, str(genome))  # no record: accepted, as before
    record_blast_db_source(prefix, str(genome))
    assert blast_db_source_matches(prefix, str(genome))
    assert not blast_db_source_matches(prefix, str(custom))
    genome.write_text(">chr1\nACGTTTTT\n")  # changed since the build
    assert not blast_db_source_matches(prefix, str(genome))


def test_virtual4c_oe_never_divides_by_an_uncovered_distance():
    from routers.microc import virtual4c_oe

    # Viewpoint 100 bins from the profile; the expected covers only 11 distances.
    matrix = np.ones((1, 10))
    short = np.array([1.0] * 10 + [0.001])
    out = virtual4c_oe(matrix, short, viewpoint_first_bin=0, profile_first_bin=100)
    assert not np.any(out > 1.5)
    np.testing.assert_allclose(out, 0.0)
    # A chromosome-wide expected covers them: uniform contacts give O/E 1.
    full = np.ones(200)
    np.testing.assert_allclose(virtual4c_oe(matrix, full, viewpoint_first_bin=0, profile_first_bin=100), 1.0)


def test_browser_selection_wins_once_the_notebook_selection_was_delivered():
    from services.jupyter_endpoint import get_selection_payload, set_selection, sync_browser_settings_for_request
    from services.jupyter_payloads import build_jupyter_poll_state

    state = SimpleNamespace(datasets={"ds1": object()}, dataset_order=["ds1"])
    jupyter = JupyterState()
    set_selection(state, jupyter, ["read_A"], "ds1")
    # Before the browser has polled, its (older) sync doesn't drop the command.
    sync_browser_settings_for_request(jupyter, JupyterBrowserSettingsSnapshotRequest(selected_read_ids={"ds1": []}))
    assert get_selection_payload(state, jupyter, "ds1")["read_ids"] == ["read_A"]
    assert build_jupyter_poll_state(jupyter)["selected_read_ids"] == {"ds1": ["read_A"]}
    # The browser got it; the user then selects read_B there.
    sync_browser_settings_for_request(jupyter, JupyterBrowserSettingsSnapshotRequest(selected_read_ids={"ds1": ["read_B"]}))
    assert get_selection_payload(state, jupyter, "ds1")["read_ids"] == ["read_B"]
    # A later notebook command's poll no longer resends read_A.
    assert build_jupyter_poll_state(jupyter)["selected_read_ids"] == {}
