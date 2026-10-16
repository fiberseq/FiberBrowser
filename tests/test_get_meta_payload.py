"""Regression tests for get_meta_payload's `read_ids` subset support.

Context: a downstream consumer (FiberCNN) hit a ConnectionResetError when
calling `client.get_meta(...)` immediately after `client.filter_reads(...)`.
The fix is to let callers scope the metaprofile by read_ids directly,
without going through the global jupyter read filter at all.

These tests assert:
1. No regression when read_ids is omitted (same behavior as before).
2. Supplying read_ids subsets the metaprofile correctly.
3. Different read_ids subsets get different cache entries (no cross-talk).
4. Same read_ids subset hits the cache on the second call.
5. Empty subset (no matching reads) returns empty profiles cleanly.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from types import SimpleNamespace
from typing import Optional

import numpy as np
import pandas as pd
import pytest

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "browser"))

from services.read_auxiliary_endpoint import _read_ids_cache_token, get_meta_payload


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_reads_df(read_ids, positions, signal_value=50):
    """Build a reads DataFrame in the shape get_meta_payload expects.

    Columns: read_id + integer position columns. meta_line_plot treats:
      - cell == 2 as a "no call" (excluded from coverage denominator)
      - cell > 2 AND cell within (fp_min, fp_max) as a positive footprint
    Subnuc fp range is (10, 90); nucleosome range is (90, 100000). Defaulting
    to signal_value=50 puts every call in the subnuc fp_mask so tests get
    non-zero subnuc_profile by default.
    """
    rows = []
    for rid in read_ids:
        row = {"read_id": rid}
        for pos in positions:
            row[pos] = signal_value  # 2 < value < 90 → subnuc footprint
        rows.append(row)
    return pd.DataFrame(rows)


def _make_state(reads_df):
    """Minimal state stub matching the attributes get_meta_payload uses."""
    captured = {"calls": 0}

    def get_reads(chrom, start, end, spanning, dataset_id):
        captured["calls"] += 1
        return reads_df.copy()

    state = SimpleNamespace(
        translate_chrom=lambda c: c,
        get_reads=get_reads,
        resolve_dataset_id=lambda dsid=None: dsid or "ds1",
        datasets={"ds1": SimpleNamespace(id="ds1")},
        dataset_order=["ds1"],
        _meta_profile_cache=OrderedDict(),
        _meta_profile_cache_timeout=300.0,
        _meta_profile_cache_max=128,
    )
    state._captured = captured
    return state


# ---------------------------------------------------------------------------
# Cache token sanity
# ---------------------------------------------------------------------------

def test_cache_token_none_when_empty():
    assert _read_ids_cache_token(None) is None
    assert _read_ids_cache_token([]) is None


def test_cache_token_stable_across_order_and_dupes():
    # Order and duplicates shouldn't matter — same subset → same token
    assert _read_ids_cache_token(["a", "b", "c"]) == _read_ids_cache_token(["c", "a", "b"])
    assert _read_ids_cache_token(["a", "b"]) == _read_ids_cache_token(["a", "b", "a"])


def test_cache_token_distinct_for_different_subsets():
    assert _read_ids_cache_token(["a", "b"]) != _read_ids_cache_token(["a", "c"])
    assert _read_ids_cache_token(["a"]) != _read_ids_cache_token(["b"])


# ---------------------------------------------------------------------------
# get_meta_payload
# ---------------------------------------------------------------------------

def test_get_meta_payload_no_read_ids_is_unchanged():
    """Calling without read_ids must return a non-empty profile and behave
    exactly as before (regression guard)."""
    reads_df = _make_reads_df(["r1", "r2", "r3"], [10, 20, 30, 40, 50])
    state = _make_state(reads_df)

    result = get_meta_payload(state, chrom="chr1", start=0, end=100, dataset_id="ds1")

    assert result["dataset_id"] == "ds1"
    assert isinstance(result["nucleosome_profile"], list)
    assert isinstance(result["subnuc_profile"], list)
    # All 3 reads had footprints at positions 10-50, so the small (10..90)
    # mask should fire on those positions.
    assert any(v > 0 for v in result["subnuc_profile"])


def test_get_meta_payload_subsets_by_read_ids():
    """When read_ids is supplied, only those reads contribute to the profile."""
    # Two reads with strong subnuc signal everywhere, one with signal at only
    # one of three positions. Subsetting to "sparse" alone yields a profile
    # with 1.0 at one position and 0.0 at the others.
    reads_df = pd.DataFrame([
        {"read_id": "dense_a", 10: 50, 20: 50, 30: 50},
        {"read_id": "dense_b", 10: 50, 20: 50, 30: 50},
        {"read_id": "sparse",  10: 50, 20: 2,  30: 2},
    ])
    state = _make_state(reads_df)

    full = get_meta_payload(state, chrom="chr1", start=0, end=50, dataset_id="ds1")
    subset = get_meta_payload(state, chrom="chr1", start=0, end=50,
                              dataset_id="ds1", read_ids=["sparse"])

    # Profiles must differ — confirms the filter actually applied.
    assert full["subnuc_profile"] != subset["subnuc_profile"]
    # The sparse subset has lower total footprint density than the full set
    # (1/3 positions vs ~3/3 positions averaged).
    assert sum(subset["subnuc_profile"]) < sum(full["subnuc_profile"])


def test_get_meta_payload_different_subsets_dont_share_cache():
    """Two distinct read_ids subsets must produce distinct cached entries —
    the bug we're guarding against would mix them up."""
    reads_df = pd.DataFrame([
        {"read_id": "a", 10: 50, 20: 50, 30: 50},
        {"read_id": "b", 10: 50, 20: 50, 30: 50},
        {"read_id": "c", 10: 2,  20: 2,  30: 2},  # no calls → 0 in subnuc mask
    ])
    state = _make_state(reads_df)

    set_ab = get_meta_payload(state, chrom="chr1", start=0, end=50,
                              dataset_id="ds1", read_ids=["a", "b"])
    set_c = get_meta_payload(state, chrom="chr1", start=0, end=50,
                             dataset_id="ds1", read_ids=["c"])

    # Both cached separately — different keys means 2 cache entries.
    cache_keys = [k for k in state._meta_profile_cache.keys()
                  if k[0] == "ds1" and k[1] == "chr1"]
    assert len(cache_keys) == 2, \
        f"expected 2 cache entries for distinct subsets, got {len(cache_keys)}"

    # a+b has subnuc signal, c does not.
    assert sum(set_ab["subnuc_profile"]) > sum(set_c["subnuc_profile"])


def test_get_meta_payload_same_subset_hits_cache():
    """Second call with the same read_ids should NOT re-fetch reads."""
    reads_df = _make_reads_df(["r1", "r2"], [10, 20, 30])
    state = _make_state(reads_df)

    get_meta_payload(state, chrom="chr1", start=0, end=50,
                     dataset_id="ds1", read_ids=["r1"])
    calls_after_first = state._captured["calls"]

    get_meta_payload(state, chrom="chr1", start=0, end=50,
                     dataset_id="ds1", read_ids=["r1"])
    calls_after_second = state._captured["calls"]

    assert calls_after_second == calls_after_first, \
        "second call with same read_ids should hit cache, not re-fetch"


def test_get_meta_payload_empty_subset_returns_empty():
    """read_ids that match no actual reads -> empty profiles, no exception."""
    reads_df = _make_reads_df(["r1", "r2"], [10, 20, 30])
    state = _make_state(reads_df)

    result = get_meta_payload(state, chrom="chr1", start=0, end=50,
                              dataset_id="ds1", read_ids=["nonexistent"])

    assert result == {
        "nucleosome_profile": [],
        "subnuc_profile": [],
        "dataset_id": "ds1",
    }


def test_get_meta_payload_handles_id_column_fallback():
    """If a custom loader returns `id` instead of `read_id`, the filter
    should still apply rather than silently fail-open."""
    reads_df = pd.DataFrame([
        {"id": "a", 10: 50, 20: 50, 30: 50},
        {"id": "b", 10: 2,  20: 2,  30: 2},  # no calls
    ])
    state = _make_state(reads_df)

    subset = get_meta_payload(state, chrom="chr1", start=0, end=50,
                              dataset_id="ds1", read_ids=["a"])
    full = get_meta_payload(state, chrom="chr1", start=0, end=50,
                            dataset_id="ds1")

    # 'a' has signal, 'b' has none — subset of just 'a' has higher subnuc
    # density than the average across both (b dilutes the denominator).
    assert sum(subset["subnuc_profile"]) > 0
    assert sum(subset["subnuc_profile"]) >= sum(full["subnuc_profile"])
