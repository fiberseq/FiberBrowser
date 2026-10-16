"""Shared test helper functions for creating synthetic compact reads."""


def make_compact_read(read_id, intervals, methyl=None):
    """Create a synthetic compact read.

    Args:
        read_id: Read identifier string
        intervals: List of [start, end, size] tuples (region-relative coordinates)
                   size > 0 = footprint, size < 0 = gap, size = 0 = no tag
        methyl: Optional list of m6A positions (region-relative)

    Returns:
        Dict matching compact read format: {id, intervals, methyl?}
    """
    read = {'id': read_id, 'intervals': intervals}
    if methyl is not None:
        read['methyl'] = methyl
    return read


def make_reads_with_footprints(n, region_width, footprint_positions=None, footprint_size=50, gap_size=-150):
    """Generate n reads with predictable footprint patterns."""
    if footprint_positions is None:
        mid = region_width // 2
        footprint_positions = [(mid - 25, mid + 25)]

    reads = []
    for i in range(n):
        intervals = []
        pos = 0
        for fp_start, fp_end in sorted(footprint_positions):
            if pos < fp_start:
                intervals.append([pos, fp_start, gap_size])
            intervals.append([fp_start, fp_end, footprint_size])
            pos = fp_end
        if pos < region_width:
            intervals.append([pos, region_width, gap_size])
        reads.append(make_compact_read(f'read_{i}', intervals))
    return reads


def make_reads_spanning_region(n, region_width):
    """Generate reads that fully span the region (single gap interval)."""
    return [make_compact_read(f'read_{i}', [[0, region_width, -150]]) for i in range(n)]


def make_reads_with_nucleosomes(n, region_width, nuc_positions=None, nuc_size=150):
    """Generate reads with nucleosome-sized footprints (>=90bp)."""
    if nuc_positions is None:
        nuc_positions = []
        pos = 0
        while pos + 150 <= region_width:
            nuc_positions.append((pos, pos + 150))
            pos += 200  # 150bp nuc + 50bp linker

    reads = []
    for i in range(n):
        intervals = []
        pos = 0
        for nuc_start, nuc_end in sorted(nuc_positions):
            if pos < nuc_start:
                intervals.append([pos, nuc_start, -50])  # linker gap
            intervals.append([nuc_start, nuc_end, nuc_size])
            pos = nuc_end
        if pos < region_width:
            intervals.append([pos, region_width, -50])
        reads.append(make_compact_read(f'read_{i}', intervals))
    return reads
