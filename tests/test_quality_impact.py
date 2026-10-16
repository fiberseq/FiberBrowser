from services.read_quality_filters import available_quality_names, quality_filter_impact


def _read(values, names=("q0",), layer="tf_sr"):
    return {"layers": {layer: {"intervals": [[i, i + 10, 10] for i in range(len(values))],
                               "quality_names": list(names), "qualities": [list(values)]}}}


def test_impact_counts_calls_each_filter_keeps():
    reads = [_read([10, 200, 250]), _read([130])]
    [impact] = quality_filter_impact(reads, [{"layer": "tf_sr", "quality_name": "q0", "min_value": 128}])
    assert (impact["total"], impact["kept"], impact["layers"]) == (4, 3, ["tf_sr"])


def test_targeted_layer_without_the_score_keeps_nothing_and_placeholders_are_ignored():
    reads = [_read([1, 2], names=("nq",), layer="nuc"), _read([0, 0], names=("aq",), layer="fire")]
    missing, fire = quality_filter_impact(reads, [
        {"layer": "nuc", "quality_name": "q0", "min_value": 1},
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ])
    assert (missing["total"], missing["kept"]) == (2, 0)
    assert (fire["total"], fire["kept"]) == (2, 2)  # all-zero aq is legacy padding
    assert available_quality_names(reads) == {"nuc": ["nq"]}
