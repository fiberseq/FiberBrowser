"""3.1.0: display, Micro-C, balanced clustering and projection samples follow the stable sampling rule
(services/stable_sample): the same seed keeps the same reads whatever their order, the window or the other reads
present; golden samples pinned so any change fails."""
import numpy as np

from services.stable_sample import seed_int, stable_key


def _reads(names):
    return [{"id": n, "intervals": [[0, 100, 100]], "start": 0, "end": 100} for n in names]


NAMES = [f"read{i:03d}" for i in range(60)]


def test_compact_all_display_sample_is_stable_and_pinned():
    from services.read_endpoint import select_compact_all_display_reads
    pick = lambda reads, n=8: sorted(r["id"] for r in select_compact_all_display_reads(
        reads, start=0, end=100, spanning=False, max_reads=n, downsample=None, coverage_sample=False, sample_seed="fiberbrowser-analysis", dataset_id="d1", chrom="chrT"))
    a = pick(_reads(NAMES))
    assert a == pick(_reads(list(reversed(NAMES))))
    # The downsample path is the same rule.
    b = sorted(r["id"] for r in select_compact_all_display_reads(_reads(NAMES), start=0, end=100, spanning=False, max_reads=100, downsample=8,
                                                                coverage_sample=False, sample_seed="fiberbrowser-analysis", dataset_id="d1", chrom="chrT"))
    assert b == a
    # More reads in another window: the sample of the common reads only loses reads, never gains excluded ones.
    more = pick(_reads(NAMES + [f"x{i}" for i in range(40)]))
    assert set(more) - {f"x{i}" for i in range(40)} <= set(a)
    assert a == GOLDEN_DISPLAY


GOLDEN_DISPLAY = ['read002', 'read004', 'read025', 'read027', 'read030', 'read036', 'read048', 'read051']


def test_balanced_indices_are_stable():
    from services.matched_view_clustering import _balanced_indices
    groups = [list(range(0, 30)), list(range(30, 40))]
    ident = lambda i: f"r{i}"
    a = _balanced_indices(groups, 42, ident)
    assert len(a) == 20 and set(range(30, 40)) <= set(a.tolist())
    assert np.array_equal(_balanced_indices([list(reversed(groups[0])), groups[1]], 42, ident), a)
    assert not np.array_equal(_balanced_indices(groups, 43, ident), a)


def test_projection_subsample_follows_the_names():
    from services.read_projection import subsample_indices
    names = [f"m{i}" for i in range(50)]
    sub = subsample_indices(50, 10, 7, names)
    chosen = {names[i] for i in sub}
    expected = set(sorted(names, key=lambda n: (stable_key(7, n), n))[:10])
    assert chosen == expected and subsample_indices(50, 60, 7, names) is None


def test_linked_compact_sample_is_order_independent():
    from services import linked_read_compact as L
    import inspect
    fn = [f for n, f in inspect.getmembers(L, inspect.isfunction) if "max_reads" in inspect.signature(f).parameters and "valid_reads" in inspect.signature(f).parameters]
    assert fn, "the linked sampler"
    f = fn[0]
    reads = [{"id": f"q{i}"} for i in range(40)]
    kw = dict(max_reads=6, sample_seed="s", session_id="sess", regions={"x_start": 0, "y_start": 0})
    a = sorted(r["id"] for r in f(reads, **kw))
    assert a == sorted(r["id"] for r in f(list(reversed(reads)), **kw))
    assert a == sorted(n for n in [r["id"] for r in reads] if n in set(sorted((r["id"] for r in reads), key=lambda n: (stable_key(seed_int("s"), "sess", n), n))[:6]))
