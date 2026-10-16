from services import external_chipatlas


def setup_function():
    external_chipatlas.chipatlas_metadata.clear()
    external_chipatlas.chipatlas_loading = False
    external_chipatlas.chipatlas_load_progress.clear()
    external_chipatlas.chipatlas_load_progress.update({"status": "idle", "message": ""})


def test_chipatlas_status_reports_loaded_genomes():
    external_chipatlas.chipatlas_metadata["dm6"] = [{"id": "EXP1"}]
    external_chipatlas.chipatlas_load_progress.update({"status": "ready", "message": "Loaded"})

    assert external_chipatlas.get_chipatlas_status_payload() == {
        "status": "ready",
        "message": "Loaded",
        "loading": False,
        "genomes_loaded": ["dm6"],
    }


def test_chipatlas_facets_count_loaded_metadata():
    external_chipatlas.chipatlas_metadata["dm6"] = [
        {"id": "E1", "antigen_class": "TFs", "cell_type_class": "embryo"},
        {"id": "E2", "antigen_class": "TFs", "cell_type_class": "embryo"},
        {"id": "E3", "antigen_class": "histone", "cell_type_class": "larva"},
    ]

    result = external_chipatlas.get_chipatlas_facets_for_genome("dm6")

    assert result["supported"] is True
    assert result["loading"] is False
    assert result["total_experiments"] == 3
    assert result["antigen_classes"][0] == {"key": "TFs", "count": 2}
    assert result["cell_type_classes"][0] == {"key": "embryo", "count": 2}


def test_chipatlas_search_filters_and_formats_tracks():
    external_chipatlas.chipatlas_metadata["dm6"] = [
        {
            "id": "EXP1",
            "antigen_class": "TFs",
            "antigen": "Pol II",
            "cell_type_class": "embryo",
            "cell_type": "2-3h",
        },
        {
            "id": "EXP2",
            "antigen_class": "histone",
            "antigen": "H3K27ac",
            "cell_type_class": "embryo",
            "cell_type": "2-3h",
        },
    ]

    result = external_chipatlas.search_chipatlas_tracks(
        genome="dm6",
        antigen_class="TFs",
        antigen="pol",
    )

    assert result["supported"] is True
    assert result["total"] == 1
    assert result["tracks"] == [{
        "url": "https://chip-atlas.dbcls.jp/data/dm6/eachData/bw/EXP1.bw",
        "label": "Pol II - 2-3h",
        "id": "EXP1",
        "antigen_class": "TFs",
        "antigen": "Pol II",
        "cell_type_class": "embryo",
        "cell_type": "2-3h",
    }]
