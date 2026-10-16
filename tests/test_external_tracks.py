"""Tests for external track handling — URL validation, track loading, UCSC API.

Uses mocking for network calls. This is the area with the most user-facing bugs.
"""

import time
import json
from unittest.mock import patch, MagicMock

from routers import external_tracks
from state.browser_state import BrowserState
from state.runtime_state import get_browser_state


# ============================================================================
# _validate_url_head
# ============================================================================

class TestValidateUrlHead:
    def setup_method(self):
        """Clear caches between tests."""
        external_tracks._url_validation_cache.clear()
        external_tracks._broken_url_cache.clear()

    def test_valid_url_returns_true(self):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch('urllib.request.urlopen', return_value=mock_resp):
            assert external_tracks._validate_url_head('https://example.com/file.bw') is True

    def test_404_returns_false(self):
        with patch('urllib.request.urlopen', side_effect=Exception('HTTP 404')):
            assert external_tracks._validate_url_head('https://example.com/missing.bw') is False

    def test_timeout_returns_false(self):
        from urllib.error import URLError
        with patch('urllib.request.urlopen', side_effect=URLError('timeout')):
            assert external_tracks._validate_url_head('https://slow.example.com/file.bw') is False

    def test_cache_hit_within_ttl(self):
        """Cached result should be returned without making a new request."""
        url = 'https://example.com/cached.bw'
        external_tracks._url_validation_cache[url] = (time.time(), True)
        with patch('urllib.request.urlopen') as mock_open:
            result = external_tracks._validate_url_head(url)
            assert result is True
            mock_open.assert_not_called()

    def test_cache_expired_revalidates(self):
        """Expired cache entries should trigger re-validation."""
        url = 'https://example.com/expired.bw'
        external_tracks._url_validation_cache[url] = (time.time() - 90000, True)
        with patch('urllib.request.urlopen', side_effect=Exception('down')):
            result = external_tracks._validate_url_head(url)
            assert result is False

    def test_broken_url_cache_blocks_validation(self):
        """URLs in broken cache should return False without HEAD request."""
        url = 'https://example.com/broken.bw'
        external_tracks._broken_url_cache[url] = time.time()
        with patch('urllib.request.urlopen') as mock_open:
            result = external_tracks._validate_url_head(url)
            assert result is False
            mock_open.assert_not_called()

    def test_broken_url_cache_expired_allows_revalidation(self):
        """Expired broken URL cache entries should allow re-validation."""
        url = 'https://example.com/wasbroken.bw'
        external_tracks._broken_url_cache[url] = time.time() - 90000

        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch('urllib.request.urlopen', return_value=mock_resp):
            result = external_tracks._validate_url_head(url)
            assert result is True
            assert url not in external_tracks._broken_url_cache

    def test_validation_result_cached(self):
        """Results of validation are cached for subsequent calls."""
        url = 'https://example.com/newurl.bw'
        with patch('urllib.request.urlopen', side_effect=Exception('fail')):
            external_tracks._validate_url_head(url)
        assert url in external_tracks._url_validation_cache
        cached_time, valid = external_tracks._url_validation_cache[url]
        assert valid is False


# ============================================================================
# /api/add_track — via full app client
# ============================================================================

class TestAddTrackEndpoint:
    def test_ucsc_api_path_parsed(self, client):
        """ucsc:// paths should be stored as ucsc_api format tracks."""
        state = get_browser_state()
        n_before = len(state.orthogonal_tracks)
        resp = client.post("/api/add_track?path=ucsc://hg38/refGene")
        data = resp.json()
        assert data['success'] is True
        assert 'UCSC API' in data['message']
        track = state.orthogonal_tracks[-1]
        assert track['format'] == 'ucsc_api'
        assert track['ucsc_genome'] == 'hg38'
        assert track['ucsc_track'] == 'refGene'
        # Cleanup
        state.orthogonal_tracks = state.orthogonal_tracks[:n_before]

    def test_ucsc_api_invalid_path(self, client):
        resp = client.post("/api/add_track?path=ucsc://invalid")
        data = resp.json()
        assert data['success'] is False

    def test_file_not_found(self, client):
        resp = client.post("/api/add_track?path=/nonexistent/file.bw")
        data = resp.json()
        assert data['success'] is False
        assert 'not found' in data['message'].lower()

    def test_local_bed_file(self, client, tmp_path):
        """Local BED files should be parsed into in-memory intervals."""
        bed = tmp_path / "test.bed"
        bed.write_text("chr1\t100\t200\tpeak1\nchr1\t300\t400\tpeak2\n")

        state = get_browser_state()
        n_before = len(state.orthogonal_tracks)
        resp = client.post(f"/api/add_track?path={str(bed)}")
        data = resp.json()
        assert data['success'] is True
        track = state.orthogonal_tracks[-1]
        assert track['format'] == 'bed'
        assert 'bed_intervals' in track
        assert len(track['bed_intervals']['chr1']) == 2
        # Cleanup
        state.orthogonal_tracks = state.orthogonal_tracks[:n_before]

    def test_add_track_error_is_json(self, client):
        """Track loading errors should return structured JSON."""
        resp = client.post("/api/add_track?path=/does/not/exist.bw")
        data = resp.json()
        assert 'success' in data
        assert 'message' in data
        assert data['success'] is False


# ============================================================================
# get_track_data — BED format binning
# ============================================================================

class TestGetTrackDataBed:
    def test_bed_intervals_binned(self):
        """BED intervals should be binned into coverage signal."""
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = [{
            'path': 'test.bed',
            'label': 'test',
            'format': 'bed',
            'bed_intervals': {
                'chr1': [
                    {'start': 100, 'end': 200},
                    {'start': 300, 'end': 400},
                ]
            }
        }]
        values = state.get_track_data(0, 'chr1', 0, 1000, bins=100)
        assert values is not None
        assert len(values) == 100
        assert values[10] > 0  # bin covering ~100
        assert values[50] == 0  # bin covering ~500

    def test_bed_intervals_outside_region(self):
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = [{
            'path': 'test.bed',
            'label': 'test',
            'format': 'bed',
            'bed_intervals': {'chr1': [{'start': 5000, 'end': 6000}]}
        }]
        values = state.get_track_data(0, 'chr1', 0, 1000, bins=100)
        assert all(v == 0 for v in values)

    def test_bed_chrom_variant_fallback(self):
        """Should try chromosome name variants (chr1 vs 1)."""
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = [{
            'path': 'test.bed',
            'label': 'test',
            'format': 'bed',
            'bed_intervals': {'1': [{'start': 100, 'end': 200}]}
        }]
        values = state.get_track_data(0, 'chr1', 0, 1000, bins=100)
        assert values is not None
        assert values[10] > 0

    def test_bed_intervals_wrap_for_circular_chromosome(self):
        state = BrowserState(None, None, None, None)
        state.circular_chroms = {'chr1': {'size': 1000, 'source': 'test'}}
        state.orthogonal_tracks = [{
            'path': 'test.bed',
            'label': 'test',
            'format': 'bed',
            'bed_intervals': {
                'chr1': [
                    {'start': 970, 'end': 990},
                    {'start': 10, 'end': 30},
                ]
            }
        }]

        values = state.get_track_data(0, 'chr1', 950, 1050, bins=10)

        # Half-open intervals: [970, 990) -> bins 2-3; [10, 30) wraps to 1010-1030 -> bins 6-7.
        assert values == [0, 0, 1, 1, 0, 0, 1, 1, 0, 0]

    def test_bed_empty_chrom(self):
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = [{
            'path': 'test.bed',
            'label': 'test',
            'format': 'bed',
            'bed_intervals': {'chr2': [{'start': 100, 'end': 200}]}
        }]
        values = state.get_track_data(0, 'chr1', 0, 1000, bins=100)
        assert values is not None
        assert all(v == 0 for v in values)


# ============================================================================
# get_track_data — UCSC API format
# ============================================================================

class TestGetTrackDataUcscApi:
    def test_ucsc_api_calls_fetch(self):
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = [{
            'path': 'ucsc://hg38/refGene',
            'label': 'refGene',
            'format': 'ucsc_api',
            'ucsc_genome': 'hg38',
            'ucsc_track': 'refGene',
        }]
        with patch.object(state, '_get_ucsc_api_signal', return_value=[0.0] * 100) as mock_signal:
            state.get_track_data(0, 'chr1', 0, 1000, bins=100)
            mock_signal.assert_called_once_with(state.orthogonal_tracks[0], 'chr1', 0, 1000, 100)

    def test_invalid_track_index(self):
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = []
        assert state.get_track_data(0, 'chr1', 0, 1000) is None
        assert state.get_track_data(-1, 'chr1', 0, 1000) is None


# ============================================================================
# _fetch_ucsc_api_intervals — caching
# ============================================================================

class TestFetchUcscApiIntervals:
    def setup_method(self):
        external_tracks._ucsc_getdata_cache.clear()

    def test_cache_hit_returns_cached_data(self):
        state = BrowserState(None, None, None, None)
        track = {'ucsc_genome': 'hg38', 'ucsc_track': 'refGene'}
        cache_key = 'hg38:refGene:chr1:0:1000'
        external_tracks._ucsc_getdata_cache[cache_key] = (time.time(), [{'start': 100, 'end': 200}])
        with patch('urllib.request.urlopen') as mock_open:
            result = state._fetch_ucsc_api_intervals(track, 'chr1', 0, 1000)
            mock_open.assert_not_called()
            assert len(result) == 1

    def test_missing_genome_returns_none(self):
        state = BrowserState(None, None, None, None)
        track = {'ucsc_genome': '', 'ucsc_track': 'refGene'}
        result = state._fetch_ucsc_api_intervals(track, 'chr1', 0, 1000)
        assert result is None

    def test_network_error_returns_none(self):
        state = BrowserState(None, None, None, None)
        track = {'ucsc_genome': 'hg38', 'ucsc_track': 'refGene'}
        with patch('urllib.request.urlopen', side_effect=Exception('Network error')):
            result = state._fetch_ucsc_api_intervals(track, 'chr1', 0, 1000)
            assert result is None

    def test_response_cached_after_fetch(self):
        state = BrowserState(None, None, None, None)
        track = {'ucsc_genome': 'hg38', 'ucsc_track': 'testTrack', 'track_type': 'bed'}
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            'testTrack': [
                {'chromStart': 100, 'chromEnd': 200, 'name': 'item1'}
            ]
        }).encode()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch('urllib.request.urlopen', return_value=mock_response):
            state._fetch_ucsc_api_intervals(track, 'chr1', 0, 1000)
        cache_key = 'hg38:testTrack:chr1:0:1000'
        assert cache_key in external_tracks._ucsc_getdata_cache


# ============================================================================
# Error propagation
# ============================================================================

class TestTrackDataErrors:
    def test_track_data_error_returns_none(self):
        """Track data errors should return None gracefully."""
        state = BrowserState(None, None, None, None)
        state.orthogonal_tracks = [{
            'path': '/nonexistent.bw',
            'label': 'bad',
            'format': 'bigWig',
        }]
        result = state.get_track_data(0, 'chr1', 0, 1000)
        assert result is None
