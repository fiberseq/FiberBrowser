"""s3:// contact maps (.mcool): read by range through boto3's URL, like BAMs.

cooler.Cooler("s3://...") never worked: h5py opens file names only.
Fixtures (a range-capable server and a fake boto3 client) come from
test_s3_access.py.
"""
from __future__ import annotations

import pytest

from test_s3_access import fake_s3, served  # noqa: F401  (fixtures)

def test_s3_mcool_reads_like_the_local_file(fake_s3, tmp_path):
    """cooler.Cooler("s3://...") can't open anything (h5py opens names only)."""
    cooler = pytest.importorskip("cooler")
    import numpy as np
    import pandas as pd
    _manager, _signed, _anon, (server, root, _cwd, _cache) = fake_s3
    bins = cooler.binnify(pd.Series({"chr1": 400_000}), 10_000)
    rng = np.random.default_rng(1)
    i, j = rng.integers(0, len(bins), 500), rng.integers(0, len(bins), 500)
    pixels = pd.DataFrame({"bin1_id": np.minimum(i, j), "bin2_id": np.maximum(i, j), "count": 1})
    pixels = pixels.groupby(["bin1_id", "bin2_id"]).sum().reset_index()
    single = str(tmp_path / "m.cool")
    cooler.create_cooler(single, bins, pixels)
    cooler.zoomify_cooler(single, str(root / "maps.mcool"), [10_000, 50_000], chunksize=10_000)

    from services.cooler_open import forget_remote_maps, mcool_resolutions, open_cooler
    try:
        assert mcool_resolutions("s3://lab/maps.mcool") == [10_000, 50_000]
        remote = open_cooler(cooler, "s3://lab/maps.mcool", 50_000)
        local = open_cooler(cooler, str(root / "maps.mcool"), 50_000)
        assert (remote.matrix(balance=False)[:] == local.matrix(balance=False)[:]).all()
        assert remote.chromsizes.to_dict() == {"chr1": 400_000}
    finally:
        forget_remote_maps(close=True)


def test_missing_s3_mcool_is_named(fake_s3):
    cooler = pytest.importorskip("cooler")
    from services.cooler_open import open_cooler
    with pytest.raises(OSError, match="Object not found: s3://lab/none.mcool"):
        open_cooler(cooler, "s3://lab/none.mcool", 1000)


def test_maps_survive_eviction_and_are_reread_after_reconfiguring(fake_s3, tmp_path):
    """Opening a fifth map closed the first under a Cooler still using it, and a
    map opened before the S3 settings changed kept reading through them."""
    cooler = pytest.importorskip("cooler")
    import shutil
    import numpy as np
    import pandas as pd
    manager, _signed, _anon, (_server, root, _cwd, _cache) = fake_s3
    bins = cooler.binnify(pd.Series({"chr1": 100_000}), 10_000)
    pixels = pd.DataFrame({"bin1_id": [0, 1], "bin2_id": [1, 2], "count": [3, 4]})
    cooler.create_cooler(str(tmp_path / "a.cool"), bins, pixels)
    for i in range(6):
        shutil.copy(str(tmp_path / "a.cool"), str(root / f"m{i}.cool"))
    from services import cooler_open
    try:
        first = cooler_open.open_cooler(cooler, "s3://lab/m0.cool")
        serial = cooler_open.map_serial("s3://lab/m0.cool")
        for i in range(1, 6):
            cooler_open.open_cooler(cooler, f"s3://lab/m{i}.cool")
        assert first.matrix(balance=False)[:].sum() == 14  # still readable
        assert cooler_open.map_serial("s3://lab/m0.cool") is None  # evicted: reopened on next use
        reopened = cooler_open.open_cooler(cooler, "s3://lab/m0.cool")
        assert cooler_open.map_serial("s3://lab/m0.cool") != serial
        url_for = cooler_open._s3_url_for("s3://lab/m0.cool")
        manager._generation += 1  # what configure() does
        assert cooler_open.map_serial("s3://lab/m0.cool") is None  # opened under the old settings
        with pytest.raises(OSError, match="S3 settings changed"):
            url_for()  # an old map's next range request
        again = cooler_open.open_cooler(cooler, "s3://lab/m0.cool")
        assert again.matrix(balance=False)[:].sum() == 14
    finally:
        cooler_open.forget_remote_maps(close=True)


def _tiny_cool(cooler, path):
    import pandas as pd
    bins = cooler.binnify(pd.Series({"chr1": 100_000}), 10_000)
    pixels = pd.DataFrame({"bin1_id": [0, 1], "bin2_id": [1, 2], "count": [3, 4]})
    cooler.create_cooler(str(path), bins, pixels)


def test_first_use_configuring_s3_is_not_a_change_of_settings(fake_s3, monkeypatch, tmp_path):
    """--cool s3://... before any S3 configuration: the first open configured S3,
    which looked like a settings change, and the map failed to load."""
    cooler = pytest.importorskip("cooler")
    manager, _signed, _anon, (_server, root, _cwd, _cache) = fake_s3
    _tiny_cool(cooler, root / "first.cool")
    monkeypatch.setattr(manager, "_configured", False)

    def configure(**kwargs):
        manager._configured = True
        manager._generation += 1
        return {"success": True}

    monkeypatch.setattr(manager, "configure", configure)
    from services import cooler_open
    try:
        clr = cooler_open.open_cooler(cooler, "s3://lab/first.cool")
        assert clr.matrix(balance=False)[:].sum() == 14
    finally:
        cooler_open.forget_remote_maps(close=True)


def test_a_replaced_map_is_reopened_on_reload_and_evicted_maps_get_a_new_token(fake_s3, tmp_path):
    cooler = pytest.importorskip("cooler")
    _manager, _signed, _anon, (_server, root, _cwd, _cache) = fake_s3
    for i in range(6):
        _tiny_cool(cooler, root / f"t{i}.cool")
    from services import cooler_open
    try:
        cooler_open.open_cooler(cooler, "s3://lab/t0.cool")
        entry = cooler_open._open_maps["s3://lab/t0.cool"]
        raw = entry[1]

        class _Gone:
            status_code = 412
            headers = {}

        with pytest.raises(OSError, match="replaced on the server"):
            raw._checked(_Gone(), 0)
        assert "s3://lab/t0.cool" not in cooler_open._open_maps  # a reload opens the new object
        cooler_open.open_cooler(cooler, "s3://lab/t0.cool")
        assert cooler_open._open_maps["s3://lab/t0.cool"][1] is not raw

        for i in range(1, 6):
            cooler_open.open_cooler(cooler, f"s3://lab/t{i}.cool")
        assert cooler_open.map_serial("s3://lab/t0.cool") is None  # evicted
        token = cooler_open.map_token("s3://lab/t0.cool")
        assert token is not None and token == cooler_open.map_serial("s3://lab/t0.cool")
    finally:
        cooler_open.forget_remote_maps(close=True)
