"""Arbitrary BAM and scan layers on an observation's measured record blocks."""
from types import SimpleNamespace


def scan_layer_rows(state, source, windows, group):
    """Read bound table layers directly, also for a source-frame live-lift scan."""
    from services.scan.registry import ensure_bound, list_scans
    from services.nuc.inputs import real
    ensure_bound(state)
    out = {}
    for scan in list_scans(state):
        bindings = {(sid, i): real(path) for sid, bid, _via, files in scan.bound_pairs()
                    if bid == source.browser_id for i, path in files.items()}
        if not bindings:
            continue
        for module, block in scan.manifest.get('modules', {}).items():
            decl = next((d for d in block.get('ma_groups') or [] if d.get('group') == group), None)
            if decl is None or decl.get('kind') not in ('state', 'mark'):
                continue
            state_group = decl['kind'] == 'state'
            rel = f'{module}/{"states" if state_group else "marks"}.tsv.bgz'
            if not scan.tables.has(rel):
                continue
            seen = set()
            for chrom, start, end in windows:
                for row in scan.tables.fetch(rel, chrom, start, end):
                    if not state_group and row.get('group') != group:
                        continue
                    path = bindings.get((row.get('dataset_id'), int(row.get('input_index') or 0)))
                    if path is None:
                        continue
                    sha, _, occ = row['record'].rpartition(':')
                    key = path, sha, int(occ)
                    signature = tuple(sorted(row.items()))
                    if signature in seen:
                        continue
                    seen.add(signature)
                    item = out.setdefault(key, dict(chrom=chrom, marks=[], measured=[], state=state_group))
                    a, b = int(row['start']), int(row['end'])
                    if state_group:
                        if row.get('state') not in ('0', '1'):
                            continue
                        item['measured'].append((a, b))
                        if row['state'] == '0':
                            continue
                    item['marks'].append((a, b))
    return out


def layer_cohort(state, observation, policy, group):
    from services.nuc.observations import resolve, _molecule_key
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.scan.overlay import apply_scan_overlays
    from services.nuc.inputs import real
    source, records, windows = resolve(state, observation, policy)
    wanted = {(r.path, r.sha, r.occ): r for r in records}
    rows = {}
    scanned = scan_layer_rows(state, source, windows, group)
    for path in source.paths:
        for chrom, start, end in windows:
            loaded = build_compact_reads_from_bam(path, chrom, start, end, include_layers=True,
                        include_lift_meta=True, include_supplementary=True, spanning_only=False,
                        hide_terminal_gaps=False, terminal_gap_threshold=0)
            loaded = apply_scan_overlays(state, source.browser_id, chrom, start, end, loaded)
            for row in loaded:
                key = (real(path), row.get('record_sha256'), int(row.get('alignment_occurrence') or 0))
                rec = wanted.get(key)
                if rec is None:
                    continue
                scan_row = scanned.get(key)
                if scan_row is not None:
                    measured = scan_row['measured'] if scan_row['state'] else rec.blocks
                    rows[key] = (rec, SimpleNamespace(chrom=chrom, measured=measured, marks=scan_row['marks'], low_information=False))
                    continue
                layer = (row.get('layers') or {}).get(group)
                # A missing layer is unmeasured, including a scan with no state for this record.
                if layer is None:
                    continue
                intervals = layer.get('intervals') or []
                qualities = layer.get('qualities') or []
                state = group in ('fpcls', 'nfrvar')
                positive, measured = [], []
                for i, iv in enumerate(intervals):
                    a, b = int(iv[0]) + start, int(iv[1]) + start
                    q = [col[i] for col in qualities if i < len(col)]
                    if state:
                        if not q or q[0] not in (1, 2):
                            continue
                        measured.append((a, b))
                        if q[0] == 2:
                            continue
                    positive.append((a, b))
                if not state:
                    measured = rec.blocks
                if key in rows:
                    old = rows[key][1]
                    measured, positive = list(old.measured) + list(measured), old.marks + positive
                rows[key] = (rec, SimpleNamespace(chrom=chrom, measured=measured, marks=positive, low_information=False))
    by_molecule = {}
    for rec, row in sorted(rows.values(), key=lambda item: item[0].supplementary):
        by_molecule.setdefault(_molecule_key(rec.qname), (rec, row))
    return source, records, windows, None, list(by_molecule.values()), {'missing': len(wanted) - len(rows)}
