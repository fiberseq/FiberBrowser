from __future__ import annotations

from services.split_view_modes import (
    normalize_split_view_mode,
    split_view_contact_mode,
    split_view_semantics,
    split_view_session_payload,
    split_view_session_summary,
)


def test_split_view_modes_use_semantic_names_with_legacy_contact_fallbacks():
    assert normalize_split_view_mode(None, "dafc") == "molecule_linked"
    assert normalize_split_view_mode(None, "microc") == "region_independent"
    assert normalize_split_view_mode("linked_molecule", None) == "molecule_linked"
    assert normalize_split_view_mode("haplotype_sync", None) == "coordinate_synced"


def test_split_view_semantics_distinguish_row_coupling():
    linked = split_view_semantics("molecule_linked")
    independent = split_view_semantics("region_independent")
    synced = split_view_semantics("coordinate_synced")

    assert linked["row_coupling"] == "molecule"
    assert linked["supports_background_reads"] is True
    assert independent["row_coupling"] == "none"
    assert synced["row_coupling"] == "syncable_independent"
    assert synced["read_source"] == "per_region_query"


def test_split_view_session_payload_backfills_legacy_sessions():
    payload = split_view_session_payload({"contact_mode": "microc"})

    assert payload["split_view_mode"] == "region_independent"
    assert payload["split_view_semantics"]["label"] == "Region-independent"


def test_split_view_contact_mode_tracks_semantic_mode():
    assert split_view_contact_mode("molecule_linked") == "dafc"
    assert split_view_contact_mode("coordinate_synced") == "microc"
    assert split_view_contact_mode("region_independent") == "microc"
    assert split_view_contact_mode("unassigned") is None


def test_split_view_session_summary_is_stable_for_unassigned_and_loaded_sessions():
    empty = split_view_session_summary({"id": "s1", "created_at": 10.0, "reads": []})

    assert empty["id"] == "s1"
    assert empty["contact_mode"] is None
    assert empty["split_view_mode"] == "unassigned"
    assert empty["has_regions"] is False
    assert empty["has_reads"] is False

    loaded = split_view_session_summary({
        "id": "s2",
        "created_at": 11.0,
        "version": 2,
        "regions": {"chrom": "chr2L", "x_start": 1, "x_end": 2, "y_start": 3, "y_end": 4},
        "reads": [{"read_id": "r1"}],
        "split_view_mode": "molecule_linked",
    })

    assert loaded["contact_mode"] == "dafc"
    assert loaded["split_view_mode"] == "molecule_linked"
    assert loaded["version"] == 2
    assert loaded["n_reads"] == 1
    assert loaded["has_regions"] is True
