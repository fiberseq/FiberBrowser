"""Navigation shortcuts retain map invalidation and active layer behavior; no HTTP server."""
from types import SimpleNamespace as NS


def test_lifted_depth_estimate_validates_one_handle_and_keeps_settings_identity(tmp_path, monkeypatch):
    from live_lift_fixtures import write_toy_sidecar, TARGET
    from services.lift.dataset import LiveLiftConfig
    from services.lift import live_lift as ll
    from services import read_sampling as rs
    config = LiveLiftConfig(write_toy_sidecar(tmp_path / 'map'), [])
    ds = NS(data_type='bam_livelift', paths=[], live_lift=config)
    reads = []
    original = LiveLiftConfig.handle.fget
    monkeypatch.setattr(LiveLiftConfig, 'handle', property(lambda self: reads.append(True) or original(self)))
    estimated = []
    monkeypatch.setattr(ll, 'estimate_lifted_reads', lambda *a: estimated.append(True) or 123)
    rs.clear_lifted_estimates()
    try:
        assert rs.estimate_dataset_reads(None, ds, TARGET, 1000, 9000) == 123
        assert len(reads) == len(estimated) == 1
        assert rs.estimate_dataset_reads(None, ds, TARGET, 1000, 9000) == 123
        assert len(reads) == 2 and len(estimated) == 1
        config.settings = ll.LiftSettings(g_split=config.settings.g_split + 1)
        assert rs.estimate_dataset_reads(None, ds, TARGET, 1000, 9000) == 123
        assert len(reads) == 3 and len(estimated) == 2
        # A sampling decision probes many neighboring windows, but they all
        # share one validated snapshot; the next decision validates again.
        assert rs.sample_level(None, ds, TARGET, 1000, 9000) == 0
        assert len(reads) == 4
        before = len(estimated)
        assert rs.sample_level(None, ds, TARGET, 1000, 9000) == 0
        assert len(reads) == 5 and len(estimated) == before
        # Even a same-content manifest replacement gets a fresh fingerprint.
        with open(config.manifest, 'a') as stream:
            stream.write('\n')
        assert rs.estimate_dataset_reads(None, ds, TARGET, 1000, 9000) == 123
        assert len(reads) == 6 and len(estimated) == before + 1
    finally:
        rs.clear_lifted_estimates()


def test_unrequested_nucleosome_outputs_do_not_lookup_the_store(monkeypatch):
    from services.nuc import layers
    class Store:
        def has_rows(self, path):
            raise AssertionError('unrequested nucleosome outputs should not query the store')
    monkeypatch.setattr(layers, 'STORE', Store())
    assert layers.injector('/fake.bam', 0, 100, include_layers=True, requested_layers={'nuc', 'tf'},
                           include_qualities=True, include_lift_meta=False) is None
