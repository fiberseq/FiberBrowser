"""FiberCNN scanner adapted for FiberBrowser compact reads.

Adapted from chipseq/build_annotation_bigbed.py. The key difference is that
FiberCacheCompact builds from FiberBrowser's compact read format
({id, intervals: [[start, end, size], ...], methyl: [...]}) instead of
BigBedReader Fiber objects.
"""
import logging
import os
import subprocess
import tempfile

import numpy as np
import torch
from pathlib import Path

logger = logging.getLogger(__name__)

SIZE_BIN_EDGES = np.array([0, 12, 16, 20, 25, 30, 40, 50, 60, 70, 80, 90,
                           110, 130, 150, 170, 200, 250, 300, 500], dtype=np.int32)

TARGET_MOTIFS = {
    'zld': [37, 38], 'gaf': [9, 10], 'dl': [16, 17, 18, 19],
    'bcd': [1, 2, 11, 12, 13], 'cad': [14], 'twi': [33, 34, 35, 36],
    'BEAF': [0], 'CLAMP_Duan': [5], 'Opa_Koromila': [26],
    'Pho_Gonzaga': [27], 'SUHW': [31],
}

TARGET_METADATA = {
    'zld':              {'category': 'pioneer_tf',  'description': 'Zelda binding'},
    'gaf':              {'category': 'pioneer_tf',  'description': 'GAF binding'},
    'dl':               {'category': 'signal_tf',   'description': 'Dorsal binding'},
    'bcd':              {'category': 'morphogen',   'description': 'Bicoid binding'},
    'cad':              {'category': 'morphogen',   'description': 'Caudal binding'},
    'twi':              {'category': 'signal_tf',   'description': 'Twist binding'},
    'BEAF':             {'category': 'insulator',   'description': 'BEAF-32 insulator'},
    'CP190':            {'category': 'insulator',   'description': 'CP190 insulator'},
    'SUHW':             {'category': 'insulator',   'description': 'Su(Hw) insulator'},
    'CLAMP_Duan':       {'category': 'chromatin',   'description': 'CLAMP chromatin factor'},
    'Opa_Koromila':     {'category': 'tf',          'description': 'Opa/Odd-paired'},
    'Combgap_Gonzaga':  {'category': 'tf',          'description': 'Combgap repressor'},
    'Pho_Gonzaga':      {'category': 'polycomb',    'description': 'Pho (PRC recruiter)'},
    'Pc_Koenecke':      {'category': 'polycomb',    'description': 'Polycomb'},
    'H2Aub_Gonzaga':    {'category': 'polycomb',    'description': 'H2Aub (Polycomb mark)'},
    'H3K27me3_Gonzaga': {'category': 'repressive',  'description': 'H3K27me3 (repressive)'},
    'H3K27ac_Zeit':     {'category': 'active_hist', 'description': 'H3K27ac (active enhancer)'},
    'H3K4me1_Zeit':     {'category': 'active_hist', 'description': 'H3K4me1 (poised/active enhancer)'},
    'H4K8ac':           {'category': 'active_hist', 'description': 'H4K8ac (active)'},
    'H2Av_pooled':      {'category': 'histone_var', 'description': 'H2A.V variant'},
    'Gcn5_CnT':         {'category': 'cofactor',    'description': 'Gcn5 HAT'},
    'Nejire_Koenecke':  {'category': 'cofactor',    'description': 'Nejire/CBP coactivator'},
}

AUTOSQL = """\
table annotationBed
"TF binding annotation"
(
    string  chrom;       "Chromosome"
    uint    chromStart;  "Start"
    uint    chromEnd;    "End"
    string  name;        "Read name"
    uint    score;       "Confidence * 1000"
    char[1] strand;      "Strand"
    string  annType;     "Annotation type (target name)"
    float   confidence;  "Binding confidence [0,1]"
)
"""

FEAT_MOTIF_START = 7  # First 7 columns are base features, rest are motifs


class FiberCacheCompact:
    """FiberCache that builds from FiberBrowser compact reads.

    Compact reads have format: {id: str, intervals: [[start, end, size], ...]}
    where start/end are relative to the region start, and size is the original
    footprint size (positive for footprints, negative for gaps).
    """

    def __init__(self, compact_reads, region_start):
        self.n_fibers = len(compact_reads)
        self.read_names = [r['id'] for r in compact_reads]

        # Compute absolute fiber spans from intervals
        fiber_starts = []
        fiber_ends = []
        fp_s, fp_e, fp_sz, fp_fi = [], [], [], []

        for fi, read in enumerate(compact_reads):
            intervals = read.get('intervals', [])
            if not intervals:
                fiber_starts.append(region_start)
                fiber_ends.append(region_start)
                continue

            # Fiber span: first interval start to last interval end (absolute)
            fiber_starts.append(region_start + intervals[0][0])
            fiber_ends.append(region_start + intervals[-1][1])

            # Flatten footprints (intervals with size > 0 are footprints)
            for iv_start, iv_end, size in intervals:
                if size > 0:  # Footprint (skip gaps which have negative size)
                    abs_start = region_start + iv_start
                    abs_end = region_start + iv_end
                    fp_s.append(abs_start)
                    fp_e.append(abs_end)
                    fp_sz.append(size)
                    fp_fi.append(fi)

        self.fiber_starts = np.array(fiber_starts, dtype=np.int64)
        self.fiber_ends = np.array(fiber_ends, dtype=np.int64)

        self.fp_starts = np.array(fp_s, dtype=np.int64)
        self.fp_ends = np.array(fp_e, dtype=np.int64)
        self.fp_sizes = np.array(fp_sz, dtype=np.int32)
        self.fp_fiberid = np.array(fp_fi, dtype=np.int32)

        # Sort by start for binary search
        if len(self.fp_starts) > 0:
            order = np.argsort(self.fp_starts)
            self.fp_starts = self.fp_starts[order]
            self.fp_ends = self.fp_ends[order]
            self.fp_sizes = self.fp_sizes[order]
            self.fp_fiberid = self.fp_fiberid[order]

        logger.info(f"FiberCacheCompact: {self.n_fibers} fibers, "
                    f"{len(self.fp_starts):,} footprints")

    def tokenize_at_position(self, center, window, chrom,
                             motif_index=None, n_motifs=40):
        """Tokenize all spanning fibers at a position.

        Returns (features, token_counts, fiber_indices) or (None, None, None).

        Identical logic to FiberCache.tokenize_at_position() from
        build_annotation_bigbed.py — vectorized feature computation.
        """
        half_w = window // 2
        win_start = center - half_w
        win_end = center + half_w

        # 1. Which fibers span this window?
        span_mask = (self.fiber_starts <= win_start) & (self.fiber_ends >= win_end)
        spanning_fi = np.where(span_mask)[0]
        if len(spanning_fi) == 0:
            return None, None, None

        # 2. Binary search: footprints overlapping [win_start, win_end)
        lo = np.searchsorted(self.fp_ends, win_start, side='right')
        hi = np.searchsorted(self.fp_starts, win_end, side='left')

        if lo >= hi:
            n = len(spanning_fi)
            return (np.zeros((n, 7 + n_motifs), dtype=np.float32),
                    np.ones(n, dtype=np.int64), spanning_fi)

        # Filter to spanning fibers only
        idx = np.arange(lo, hi)
        fids = self.fp_fiberid[idx]
        keep = np.isin(fids, spanning_fi)
        idx = idx[keep]
        fids = fids[keep]

        if len(idx) == 0:
            n = len(spanning_fi)
            return (np.zeros((n, 7 + n_motifs), dtype=np.float32),
                    np.ones(n, dtype=np.int64), spanning_fi)

        # 3. Window-relative coordinates (all vectorized)
        abs_s = self.fp_starts[idx]
        abs_e = self.fp_ends[idx]
        sizes = self.fp_sizes[idx].astype(np.float32)
        rel_s = np.maximum(0, abs_s - win_start).astype(np.float32)
        rel_e = np.minimum(window, abs_e - win_start).astype(np.float32)

        # Sort by (fiber_id, rel_start) for gap detection
        order = np.lexsort((rel_s, fids))
        fids = fids[order]
        rel_s = rel_s[order]
        rel_e = rel_e[order]
        sizes = sizes[order]
        abs_s = abs_s[order]
        abs_e = abs_e[order]
        n_fps = len(fids)

        # 4. Vectorized footprint token features
        mids = (rel_s + rel_e) / 2.0
        positions = (mids - half_w) / half_w
        size_bins = np.clip(
            np.searchsorted(SIZE_BIN_EDGES, sizes.astype(np.int32), side='right') - 1,
            0, 19).astype(np.float32)
        clipped = (np.maximum(0, -(abs_s - win_start)) +
                   np.maximum(0, abs_e - win_end)).astype(np.float32)
        clipped_fracs = clipped / np.maximum(sizes, 1)
        log_sizes = np.log2(np.maximum(sizes, 1))

        # 5. Vectorized gap detection
        if n_fps > 1:
            same_fiber = fids[1:] == fids[:-1]
            gap_widths = rel_s[1:] - rel_e[:-1]
            is_gap = same_fiber & (gap_widths > 100)
            gap_idx = np.where(is_gap)[0]
        else:
            gap_idx = np.array([], dtype=np.int64)
        n_gaps = len(gap_idx)

        # Gap features (vectorized)
        if n_gaps > 0:
            g_starts = rel_e[gap_idx]
            g_ends = rel_s[gap_idx + 1]
            g_widths = g_ends - g_starts
            g_mids = (g_starts + g_ends) / 2.0
            g_positions = (g_mids - half_w) / half_w
            g_log_widths = np.log2(np.maximum(g_widths, 1))
            g_fids = fids[gap_idx]

        # 6. Assemble token array: [footprints | gaps]
        n_total = n_fps + n_gaps
        features = np.zeros((n_total, 7 + n_motifs), dtype=np.float32)

        # Footprint tokens
        features[:n_fps, 0] = size_bins
        features[:n_fps, 2] = log_sizes
        features[:n_fps, 3] = positions
        features[:n_fps, 4] = clipped_fracs
        features[:n_fps, 5] = 0.5

        # Gap tokens
        if n_gaps > 0:
            o = n_fps
            features[o:o + n_gaps, 1] = 1  # token_type = gap
            features[o:o + n_gaps, 2] = g_log_widths
            features[o:o + n_gaps, 3] = g_positions
            features[o:o + n_gaps, 6] = g_log_widths

        # Token fiber IDs and sort keys
        tok_fids = np.empty(n_total, dtype=np.int32)
        tok_fids[:n_fps] = fids
        tok_sort = np.empty(n_total, dtype=np.float32)
        tok_sort[:n_fps] = mids
        if n_gaps > 0:
            tok_fids[n_fps:] = g_fids
            tok_sort[n_fps:] = g_mids

        # 7. Motif assignment — query ONCE, assign via vectorized comparisons
        if motif_index is not None and n_motifs > 0:
            m_pos, m_ids = motif_index.query_window(chrom, win_start, win_end)
            if len(m_pos) > 0:
                tok_abs_lo = np.empty(n_total, dtype=np.int64)
                tok_abs_hi = np.empty(n_total, dtype=np.int64)
                tok_abs_lo[:n_fps] = np.maximum(abs_s, win_start)
                tok_abs_hi[:n_fps] = np.minimum(abs_e, win_end)
                if n_gaps > 0:
                    tok_abs_lo[n_fps:] = (win_start + g_starts).astype(np.int64)
                    tok_abs_hi[n_fps:] = (win_start + g_ends).astype(np.int64)

                for mi in range(len(m_pos)):
                    mp = int(m_pos[mi])
                    mid_val = int(m_ids[mi])
                    if mid_val >= n_motifs:
                        continue
                    containing = (tok_abs_lo <= mp) & (tok_abs_hi > mp)
                    features[containing, 7 + mid_val] += 1

        # 8. Sort tokens within each fiber by position
        sort_order = np.lexsort((tok_sort, tok_fids))
        features = features[sort_order]
        tok_fids = tok_fids[sort_order]

        # 9. Build output grouped by spanning fiber
        unique_fids, counts = np.unique(tok_fids, return_counts=True)
        fid_to_offset = {}
        cumsum = 0
        for fid, cnt in zip(unique_fids, counts):
            fid_to_offset[int(fid)] = (cumsum, cumsum + cnt)
            cumsum += cnt

        out_features = []
        out_tc = []
        out_fi = []
        empty_tok = np.zeros((1, 7 + n_motifs), dtype=np.float32)

        for fi in spanning_fi:
            fi_int = int(fi)
            if fi_int in fid_to_offset:
                s, e = fid_to_offset[fi_int]
                out_features.append(features[s:e])
                out_tc.append(e - s)
            else:
                out_features.append(empty_tok)
                out_tc.append(1)
            out_fi.append(fi_int)

        return (np.concatenate(out_features),
                np.array(out_tc, dtype=np.int64),
                np.array(out_fi, dtype=np.int64))


def _raw_to_token_features(features, device):
    """Convert raw (N, F) feature array to named token feature dict."""
    n_total = features.shape[1]
    n_motifs = n_total - FEAT_MOTIF_START
    result = {
        'size_bins': torch.from_numpy(features[:, 0].astype(np.int64)).to(device),
        'token_types': torch.from_numpy(features[:, 1].astype(np.int64)).to(device),
        'log_sizes': torch.from_numpy(features[:, 2].copy()).float().to(device),
        'positions': torch.from_numpy(features[:, 3].copy()).float().to(device),
        'clipped_fracs': torch.from_numpy(features[:, 4].copy()).float().to(device),
        'at_fracs': torch.from_numpy(features[:, 5].copy()).float().to(device),
        'log_gap_widths': torch.from_numpy(features[:, 6].copy()).float().to(device),
    }
    if n_motifs > 0:
        result['motif_counts'] = torch.from_numpy(
            features[:, FEAT_MOTIF_START:].copy()
        ).float().to(device)
    else:
        result['motif_counts'] = torch.zeros(len(features), 1).float().to(device)
    return result


def collect_motif_positions(motif_index, chrom, region_start, region_end, scan_tfs):
    """Find all unique motif positions for the requested TFs in the region."""
    all_positions = set()
    for tf_name in scan_tfs:
        if tf_name not in TARGET_MOTIFS:
            continue
        motif_ids = set(TARGET_MOTIFS[tf_name])
        positions, mids = motif_index.query_window(chrom, region_start, region_end)
        for p, m in zip(positions, mids):
            if int(m) in motif_ids:
                all_positions.add(int(p))
    return sorted(all_positions)


def scan_region(
    model, target_names, n_motifs, target_p99,
    fiber_cache, motif_index,
    chrom, region_start, region_end,
    pred_window, min_confidence, device,
    progress_callback=None,
):
    """Predict all targets at every motif position. Returns (rows, per_target_counts, n_positions).

    rows: list of (chrom, start, end, read_name, score, strand, target, confidence)
    per_target_counts: {target_name: count}
    n_positions: number of motif positions scanned
    """
    target_list = list(target_names)
    n_targets = len(target_list)

    p99_arr = np.ones(n_targets, dtype=np.float64)
    if target_p99 is not None:
        for ti in range(n_targets):
            v = float(target_p99[ti])
            p99_arr[ti] = v if v > 0 else 1.0

    # Determine which TFs to scan (those with cognate motifs in the model)
    scan_tfs = [t for t in TARGET_MOTIFS if t in target_list]

    motif_positions = collect_motif_positions(
        motif_index, chrom, region_start, region_end, scan_tfs)
    logger.info(f"  {len(motif_positions)} unique motif positions from "
                f"{len(scan_tfs)} TFs")

    n_positions = len(motif_positions)
    if not motif_positions:
        return [], {}, 0

    rows = []
    per_target_counts = {t: 0 for t in target_list}

    for mi, motif_pos in enumerate(motif_positions):
        features, token_counts, fiber_indices = fiber_cache.tokenize_at_position(
            motif_pos, pred_window, chrom,
            motif_index=motif_index, n_motifs=n_motifs,
        )
        if features is None:
            if progress_callback and (mi + 1) % 10 == 0:
                progress_callback(mi + 1, n_positions, len(rows))
            continue

        token_features = _raw_to_token_features(features, device)
        tc = torch.from_numpy(token_counts).to(device)

        with torch.no_grad(), torch.amp.autocast('cuda'):
            preds = model.predict_per_fiber(token_features, tc)

        raw = preds.cpu().float().numpy()

        if target_p99 is not None:
            confidence_all = np.clip(raw / p99_arr[np.newaxis, :], 0.0, 1.0)
        else:
            confidence_all = np.clip(raw, 0.0, 1.0)

        ann_start = motif_pos - 10
        ann_end = motif_pos + 10

        for i, fi in enumerate(fiber_indices):
            read_name = fiber_cache.read_names[fi]
            for ti in range(n_targets):
                conf = float(confidence_all[i, ti])
                if conf < min_confidence:
                    continue
                score = int(conf * 1000)
                rows.append((chrom, ann_start, ann_end, read_name, score, '.',
                             target_list[ti], conf))
                per_target_counts[target_list[ti]] += 1

        if progress_callback and (mi + 1) % 10 == 0:
            progress_callback(mi + 1, n_positions, len(rows))

    logger.info(f"  Total: {len(rows):,} entries (conf >= {min_confidence})")
    for t in target_list:
        if per_target_counts[t] > 0:
            logger.info(f"    {t}: {per_target_counts[t]:,}")

    return rows, per_target_counts, n_positions


def write_temp_bigbed(rows, chrom_sizes_path):
    """Write annotation rows to a temporary BigBed file. Returns the path."""
    rows.sort(key=lambda r: (r[0], r[1], r[2]))

    tmp_dir = tempfile.mkdtemp(prefix='fibercnn_')
    bb_path = os.path.join(tmp_dir, 'scan.ann.bb')

    as_path = os.path.join(tmp_dir, 'annotation.as')
    with open(as_path, 'w') as f:
        f.write(AUTOSQL)

    bed_path = os.path.join(tmp_dir, 'annotations.bed')
    with open(bed_path, 'w') as f:
        for row in rows:
            ch, s, e, name, score, strand, ann_type, conf = row
            f.write(f"{ch}\t{s}\t{e}\t{name}\t{score}\t{strand}"
                    f"\t{ann_type}\t{conf:.6f}\n")

    logger.info(f"Wrote {len(rows)} rows to temp BED")

    cmd = ['bedToBigBed', '-type=bed6+2', f'-as={as_path}',
           bed_path, str(chrom_sizes_path), bb_path]
    logger.info("Running bedToBigBed...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"bedToBigBed failed:\n{result.stderr}")
        raise RuntimeError(f"bedToBigBed failed: {result.stderr}")

    logger.info(f"BigBed written: {bb_path}")
    return bb_path
