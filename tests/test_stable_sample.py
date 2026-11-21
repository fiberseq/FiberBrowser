"""The one sampling rule (services/stable_sample.py): blake2b keys pinned by golden values (the browser's
utils/stableSample.test.ts asserts the same), a golden sample list so any change to the sampler fails, order and
chunk independence, a fresh interpreter (restart) giving the same sample, and different seeds giving different ones."""
import subprocess
import sys

from services.stable_sample import lowest_k, sample_names, stable_key

NAMES = [f"read{i}" for i in range(200)]
GOLDEN_SEED1 = ['read71', 'read63', 'read134', 'read198', 'read48', 'read163', 'read61', 'read84', 'read65', 'read150']


def test_keys_are_pinned():
    assert stable_key(1) == 16513079772995842083
    assert stable_key(7) == 13805528602901388239
    assert stable_key(1, "ds1") == 555083412080106611
    assert stable_key(1, "ds1", "m84046/1/ccs") == 13303154941664623350
    assert stable_key(7, "ds1", "m84046/1/ccs") == 5841588228132999484
    assert stable_key(1, "é") == 7315250790590001095


def test_golden_sample():
    assert sample_names(NAMES, 10, 1, "ds") == GOLDEN_SEED1


def test_order_and_chunk_independent():
    assert sample_names(list(reversed(NAMES)), 10, 1, "ds") == GOLDEN_SEED1
    # Chunks: each chunk's lowest-10, then the lowest-10 of those = the whole set's lowest-10.
    for size in (7, 50, 200):
        parts = [sample_names(NAMES[i:i + size], 10, 1, "ds") for i in range(0, len(NAMES), size)]
        assert sample_names([n for p in parts for n in p], 10, 1, "ds") == GOLDEN_SEED1


def test_same_after_restart():
    code = "from services.stable_sample import sample_names; print(sample_names([f'read{i}' for i in range(200)], 10, 1, 'ds'))"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=__import__('os').path.join(__import__('os').path.dirname(__file__), "..", "browser"),
                         env={**__import__('os').environ, "PYTHONHASHSEED": "12345"})
    assert out.stdout.strip() == repr(GOLDEN_SEED1)


def test_seeds_differ_and_scope_matters():
    assert set(sample_names(NAMES, 10, 2, "ds")) != set(GOLDEN_SEED1)
    assert set(sample_names(NAMES, 10, 1, "other")) != set(GOLDEN_SEED1)
    assert lowest_k([3, 1, 2], -1, key=lambda x: x) == [1, 2, 3]


def test_poisson_bootstrap_weights_are_pinned():
    from services.stable_sample import percentile_interval, poisson_weight, poisson_weights
    assert poisson_weights(1, "u1", 12) == [2, 0, 1, 3, 0, 0, 0, 0, 0, 1, 1, 2]
    assert poisson_weights(7, "read9", 12) == [3, 1, 2, 2, 0, 1, 0, 1, 0, 1, 0, 2]
    assert poisson_weight(7, 4, "read9") == 0
    assert percentile_interval([3, 1, 2, 5, 4], 0.5) == (2.0, 4.0)
    # Mean weight ~1 (Poisson(1)).
    ws = [w for i in range(40) for w in poisson_weights(3, f"u{i}", 50)]
    assert 0.9 < sum(ws) / len(ws) < 1.1


def test_poisson_weight_matrix_matches_the_unit_streams():
    from services.stable_sample import poisson_weight_matrix, poisson_weights
    m = poisson_weight_matrix(1, ["u1", "read9"], 12)
    assert m[0].tolist() == poisson_weights(1, "u1", 12) == [2, 0, 1, 3, 0, 0, 0, 0, 0, 1, 1, 2]
    assert m[1].tolist() == poisson_weights(1, "read9", 12)
    assert poisson_weight_matrix(7, ["read9"], 12)[0].tolist() == [3, 1, 2, 2, 0, 1, 0, 1, 0, 1, 0, 2]
