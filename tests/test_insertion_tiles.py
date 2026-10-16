"""Insertions in view (the insertion lens): the background tile cache answers as one scan does."""
import os
import time

import pytest

from services import background_work as BW


# ---------------------------------------------------------------------------
# Insertions in view: the tile cache answers as one scan does


@pytest.fixture(scope="module")
def insertion_bam(tmp_path_factory):
    from insertion_fixtures import make_insertion_bam
    return make_insertion_bam(tmp_path_factory.mktemp("insertion-tiles"))


def test_tiled_insertion_clusters_match_one_scan(insertion_bam):
    from insertion_fixtures import SITE
    from services.insertion_lens import find_clusters

    bam = insertion_bam["bam"]
    cache = BW.ResultCache(max_entries=100)
    for lo, hi in [(SITE - 500, SITE + 500), (SITE - 3000, SITE + 3000), (SITE - 9000, SITE + 200),
                   (0, SITE + 9000), (SITE - 20, SITE + 20)]:
        plain = find_clusters([bam], "chrT", lo, hi, min_len=50)
        tiled = find_clusters([bam], "chrT", lo, hi, min_len=50, tile_cache=cache)
        assert tiled == plain, (lo, hi)
    assert any(c["len"] > 1500 for c in find_clusters([bam], "chrT", SITE - 500, SITE + 500, min_len=50, tile_cache=cache))


def test_a_panned_view_reads_only_its_new_tiles(insertion_bam, monkeypatch):
    from insertion_fixtures import SITE
    from services import insertion_lens as IL

    fetched = []
    real = IL._site_records

    def spy(paths, chrom, start, end, **kw):
        fetched.append((start, end))
        return real(paths, chrom, start, end, **kw)

    monkeypatch.setattr(IL, "_site_records", spy)
    cache = BW.ResultCache(max_entries=100)
    span = 20_000
    size = IL.cluster_tile_size(span)
    lo = (SITE // size) * size
    IL.find_clusters([insertion_bam["bam"]], "chrT", lo, lo + span, tile_cache=cache)
    first = list(fetched)
    fetched.clear()
    IL.find_clusters([insertion_bam["bam"]], "chrT", lo + size, lo + size + span, tile_cache=cache)
    # One fetch, of the one tile not read before.
    assert len(first) == 1
    assert len(fetched) == 1 and fetched[0][1] - fetched[0][0] == size
    fetched.clear()
    IL.find_clusters([insertion_bam["bam"]], "chrT", lo, lo + span, tile_cache=cache)
    assert fetched == []


def test_a_new_bam_file_is_a_new_tile_key(insertion_bam, tmp_path):
    from insertion_fixtures import SITE
    from services import insertion_lens as IL

    cache = BW.ResultCache(max_entries=100)
    IL.find_clusters([insertion_bam["bam"]], "chrT", SITE - 500, SITE + 500, tile_cache=cache)
    n = len(cache)
    os.utime(insertion_bam["bam"], ns=(time.time_ns(), time.time_ns() + 10**9))
    IL.find_clusters([insertion_bam["bam"]], "chrT", SITE - 500, SITE + 500, tile_cache=cache)
    assert len(cache) > n


# ---------------------------------------------------------------------------
# A cancelled load is never cached
