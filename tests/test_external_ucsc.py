from types import SimpleNamespace

from services import external_ucsc


def _state_with_tracks(*paths):
    return SimpleNamespace(orthogonal_tracks=[{"path": path} for path in paths])


def test_ucsc_curated_payload_marks_loaded_tracks():
    state = _state_with_tracks(
        "https://hgdownload.soe.ucsc.edu/goldenPath/dm6/phyloP124way/dm6.phyloP124way.bw"
    )

    result = external_ucsc.get_ucsc_curated_payload("dm6", state)

    assert result["genome"] == "dm6"
    assert result["tracks"][0]["loaded"] is True
    assert all("render_mode" in track for track in result["tracks"])


def test_ucsc_search_uses_disk_cache_and_marks_loaded():
    external_ucsc._ucsc_track_cache.clear()
    external_ucsc._disk_cache["test_ucsc_tracks"] = {
        "loadable": [
            {
                "id": "tfSignal",
                "label": "TF signal",
                "description": "factor",
                "category": "regulation",
                "url": "https://example.org/tf.bw",
            },
            {
                "id": "rnaSignal",
                "label": "RNA signal",
                "description": "rna",
                "category": "rna",
                "url": "https://example.org/rna.bw",
            },
        ],
        "all": [],
    }

    result = external_ucsc.search_ucsc_tracks_for_state(
        "test",
        "TF",
        _state_with_tracks("https://example.org/tf.bw"),
    )

    assert result["total"] == 2
    assert result["tracks"] == [{
        "id": "tfSignal",
        "label": "TF signal",
        "description": "factor",
        "category": "regulation",
        "url": "https://example.org/tf.bw",
        "loaded": True,
    }]


def test_ucsc_browse_groups_tracks_by_friendly_category():
    external_ucsc._ucsc_track_cache.clear()
    external_ucsc._disk_cache["browse_ucsc_tracks"] = {
        "loadable": [{"id": "refGene"}],
        "all": [
            {
                "id": "refGene",
                "label": "RefSeq",
                "category": "genes",
                "url": "ucsc://browse/refGene",
                "loadable": True,
            },
            {
                "id": "nestedOnly",
                "label": "Nested",
                "category": "custom_group",
                "url": "",
                "loadable": False,
            },
        ],
    }

    result = external_ucsc.browse_ucsc_tracks_for_state(
        "browse",
        _state_with_tracks("ucsc://browse/refGene"),
    )

    assert result["loadable_count"] == 1
    assert result["groups"]["Genes"][0]["loaded"] is True
    assert result["groups"]["Custom Group"][0]["loaded"] is False
