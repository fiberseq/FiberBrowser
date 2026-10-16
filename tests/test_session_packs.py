"""Sessions and plugin packs on the server: which packs a session needs that this build lacks (results.missing_packs),
and the parts a pack's export hook wrote (session["packs"][name]["parts"])."""
from __future__ import annotations

from plugins.packs import PACK_PARTS_KEY, PackAPI, PackHooks, PackInfo


def test_a_missing_pack_is_reported_only_when_the_session_holds_its_parts():
    from services.sessions_endpoint import _missing_packs
    info = {"name": "extras", "label": "Extra features", "flavor": "extras"}
    assert _missing_packs({"packs": {"extras": {**info, "parts": []}}}) == []
    assert _missing_packs({"packs": {"extras": {**info, "parts": ["extra_runs"]}}, "extra_runs": []}) == []
    assert _missing_packs({"packs": {"extras": {**info, "parts": ["extra_runs"]}}, "extra_runs": [1]}) == ["Extra features"]
    # Sessions written before packs listed their parts: the browser says what was left out (it knows each part), the
    # server only its datasets.
    assert _missing_packs({"packs": {"extras": info}}) == []
    assert _missing_packs({"packs": {"extras": info}, "datasets": [{"id": "o", "paths": ["/o.bam"], "pack": "extras"}]}) == ["Extra features"]


def test_a_dataset_entry_this_build_restores_is_not_missing():
    # An alt-allele dataset an older lab build marked as its pack's: core restores it now.
    from services.sessions_endpoint import _missing_packs
    alt = {"id": "alt1", "paths": ["/x/carriers.bam"], "pack": "extras", "alt_allele": {"definition": {}}}
    assert _missing_packs({"packs": {"extras": {"label": "Extra features", "parts": []}}, "datasets": [alt]}) == []
    other = {"id": "o", "paths": ["/x/o.bam"], "pack": "extras"}
    assert _missing_packs({"packs": {"extras": {"label": "Extra features", "parts": []}}, "datasets": [other]}) == ["Extra features"]


def test_a_packs_export_hook_lists_the_keys_it_added():
    hooks = PackHooks()
    api = PackAPI(PackInfo(name="extras", label="Extra", flavor="extras", module="x", path="."), hooks)
    api.on_session_export(lambda state, fe, session: session.update(extra_runs=[1]))
    session = {"datasets": []}
    for fn in hooks.session_export:
        fn(None, {}, session)
    assert session[PACK_PARTS_KEY] == {"extras": ["extra_runs"]}


def test_core_features_mark_nothing_as_a_packs():
    hooks = PackHooks()
    api = PackAPI(PackInfo(name="core", label="core", flavor="public", module="x", path="."), hooks, builtin=True)
    api.dataset_session_entry(lambda dataset: {"alt_allele": {"a": 1}})
    api.on_session_export(lambda state, fe, session: session.update(core_part=1))
    assert hooks.dataset_session_entry[0](object()) == {"alt_allele": {"a": 1}}
    session = {}
    hooks.session_export[0](None, {}, session)
    assert PACK_PARTS_KEY not in session


def test_the_builtin_features_restore_alt_allele_datasets():
    from plugins.packs import hooks, loaded_packs, restorer_for
    loaded_packs()
    assert restorer_for({"alt_allele": {"definition": {}}, "pack": "lab"}) is not None
    assert all(info.name != "core" for info in loaded_packs())
    assert hooks().fasta_context
