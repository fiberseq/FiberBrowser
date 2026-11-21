"""Dev line: FiberHMM var / sv layers answer only bigBed datasets; live-lift (and native BAM) datasets keep their own
SV split and Variants paths."""
from types import SimpleNamespace as NS

from services import fiberhmm_variant_layers as fvl


def test_layers_never_attach_to_live_lift_or_bam_datasets():
    companions = {"var": ["v.bb"], "sv": ["s.bb"]}
    for data_type in ("bam_livelift", "bam"):
        ds = NS(data_type=data_type, companion_layers=companions, layer_type=None, paths=["x.bam"])
        assert not fvl.has_layer(ds, fvl.VAR_LAYER) and not fvl.has_layer(ds, fvl.SV_LAYER)
    bigbed = NS(data_type="bigbed", companion_layers=companions, layer_type="footprint", paths=["f.bb"])
    assert fvl.has_layer(bigbed, fvl.VAR_LAYER) and fvl.has_layer(bigbed, fvl.SV_LAYER)


def test_variants_requests_route_by_dataset_kind(monkeypatch):
    from services import variants_endpoint as ve
    lifted = NS(id="ll", data_type="bam_livelift", companion_layers={"sv": ["s.bb"]}, layer_type=None, paths=[])
    state = NS(get_dataset=lambda d: lifted if d == "ll" else None)
    assert ve._variant_layer_dataset(state, {"dataset_id": "ll"}, fvl.SV_LAYER) is None
